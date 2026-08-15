/**
 * Structured-review pipeline: risk-scored batching + structured-findings output.
 *
 * This module is the fork's single best engineering idea. Instead of lossily
 * truncating a large PR (the upstream's only strategy), this module:
 *   1. risk-scores each changed file (size + status + path patterns),
 *   2. line-split big patches into char-budgeted chunks,
 *   3. packs the resulting entries into char+file-budgeted batches
 *      (highest-risk first),
 *   4. reviews each batch via an INJECTED `callApi`, instructing the model to
 *      emit a STRICTLY structured JSON object ({summary, findings}), and
 *   5. on a context-overflow error from a batch, recursively halves that
 *      batch until each half fits.
 *
 * Two layers, on purpose:
 *   - PURE pipeline (`scoreFile`, `splitTextByLines`, `createReviewEntries`,
 *     `createReviewBatches`, `formatEntry`, `isLargePr`,
 *     `isContextLimitError`). No I/O. Deterministic. Tested exhaustively.
 *   - ORCHESTRATION (`executeStructuredBatch`, `runStructuredReview`). Stateful,
 *     but the network is ALWAYS injected via `deps.callApi` — production wires
 *     it to api.js's client, tests pass a fake. This module never touches the
 *     network directly, which keeps it testable and makes api.js the single
 *     transport.
 *
 * @module src/lib/auto-review.js
 */

import { buildStructuredReviewPrompt } from './prompt.js';
import {
  parseStructuredReview,
  rankAndCapFindings,
  mergeFindings,
} from './findings.js';

/* ------------------------------------------------------------------ *
 * Constants (exact values per the task brief — do not change)
 * ------------------------------------------------------------------ */

export const HIGH_RISK_PATTERNS = [
  /(^|\/)(auth|security|permissions?|policy|policies)(\/|\.|$)/i,
  /(^|\/)(api|server|backend|worker|workers|db|database|migration|migrations)(\/|\.|$)/i,
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|action\.yml|dockerfile|docker-compose|\.github\/workflows\/)/i,
  /\.(js|cjs|mjs|ts|tsx|jsx|py|go|rs|java|cs|sql|yml|yaml)$/i,
];

export const DEFAULTS = {
  largePrFileThreshold: 50,
  maxBatchChars: 120000,
  maxFilesPerBatch: 40,
  maxPatchChars: 18000,
  maxFindings: 8,
  minSeverity: 'info',
};

/* ------------------------------------------------------------------ *
 * Pure pipeline
 * ------------------------------------------------------------------ */

/**
 * Patch length, safely. Returns 0 if `file.patch` is not a string.
 */
export function getPatchLength(file) {
  return typeof file?.patch === 'string' ? file.patch.length : 0;
}

/**
 * Risk score for a file. Larger + added/renamed + high-risk path → higher.
 *
 * - +Math.min(40, ceil(patchLength / 800)) for size
 * - +8 if status is 'added' or 'renamed'
 * - +24 if filename matches any HIGH_RISK_PATTERNS
 */
export function scoreFile(file) {
  let score = 0;
  score += Math.min(40, Math.ceil(getPatchLength(file) / 800));
  if (file?.status === 'added' || file?.status === 'renamed') score += 8;
  if (HIGH_RISK_PATTERNS.some((p) => p.test(file?.filename || ''))) score += 24;
  return score;
}

/**
 * Priority comparator for entries: higher priority first, then larger patch,
 * then filename asc. Used by createReviewEntries.
 */
export function compareByPriority(a, b) {
  if (b.priority !== a.priority) return b.priority - a.priority;
  if (b.patchLength !== a.patchLength) return b.patchLength - a.patchLength;
  return a.filename.localeCompare(b.filename);
}

/**
 * Line-aware chunking. Never splits a line mid-way unless a single line
 * exceeds `maxChars`, in which case that line is sliced into maxChars-sized
 * pieces (and no other lines are mixed into those slices).
 *
 * Returns chunks filtered to drop empty strings.
 */
export function splitTextByLines(text, maxChars) {
  const source = typeof text === 'string' ? text : '';
  // Defense-in-depth: a non-positive maxChars would make the inner
  // `for (i += maxChars)` loop never terminate (i += 0) or run backwards
  // (i += negative). Config validation clamps these, but guard here too so a
  // future caller cannot trigger the hang. Treat bad input as "no chunking".
  if (!Number.isFinite(maxChars) || maxChars < 1) return [source];
  if (!source || source.length <= maxChars) return [source];

  const lines = source.split('\n');
  const chunks = [];
  let current = [];
  let currentLength = 0;

  const flush = () => {
    if (current.length > 0) {
      chunks.push(current.join('\n'));
      current = [];
      currentLength = 0;
    }
  };

  for (const line of lines) {
    if (line.length > maxChars) {
      // A single oversized line: flush pending, then slice this line.
      flush();
      let i = 0;
      while (i < line.length) {
        let end = Math.min(i + maxChars, line.length);
        // W11-9: don't split a UTF-16 surrogate pair. If the char at end-1 is
        // a high surrogate and `end` is still inside the string (followed by a
        // low surrogate), back up by one so the pair stays in the same chunk.
        // Without this, the two halves land in separate chunks and serialize
        // as U+FFFD when sent to the LLM — silent corruption of diff content.
        if (end < line.length) {
          const code = line.charCodeAt(end - 1);
          if (code >= 0xD800 && code <= 0xDBFF) end -= 1;
        }
        // Safety: if maxChars is 1 and the char at i is a high surrogate, end
        // would equal i and we'd loop forever. Force at least one char of
        // progress so the lone surrogate moves into a chunk on its own.
        if (end === i) end = i + 1;
        chunks.push(line.slice(i, end));
        i = end;
      }
      continue;
    }
    const addLength = line.length + (current.length > 0 ? 1 : 0); // +1 for the '\n' joiner
    if (currentLength + addLength > maxChars) {
      flush();
    }
    current.push(line);
    currentLength += line.length + (current.length > 1 ? 1 : 0); // update with joiner
  }
  flush();
  return chunks.filter(Boolean);
}

/**
 * Build review entries from raw files. Filters out files with no patch,
 * splits large patches via splitTextByLines, sorts by priority.
 *
 * Each entry: { filename, status, patch, chunkIndex, chunkCount, priority, patchLength }
 */
export function createReviewEntries(files, options = {}) {
  const maxPatchChars = options.maxPatchChars || DEFAULTS.maxPatchChars;
  const out = [];
  for (const file of files || []) {
    if (typeof file?.patch !== 'string' || file.patch.length === 0) continue;
    const chunks = splitTextByLines(file.patch, maxPatchChars);
    const priority = scoreFile(file);
    const patchLength = getPatchLength(file);
    const status = file.status || 'modified';
    chunks.forEach((chunk, i) => {
      out.push({
        filename: file.filename,
        status,
        patch: chunk,
        chunkIndex: i + 1,
        chunkCount: chunks.length,
        priority,
        patchLength,
      });
    });
  }
  out.sort(compareByPriority);
  return out;
}

/**
 * Escape a string for an XML attribute value (`name="…"`). Neutralizes `"`,
 * `&`, `<`, `>` so a hostile filename cannot break out of the attribute or
 * inject tag structure into the prompt.
 */
function escapeXmlAttribute(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Escape structural XML tags (both open and close) inside patch bodies so an
 * attacker cannot inject `</diff>`, `</file>`, `</review_batch>`, or their
 * opening equivalents to break out of the wrapping boundary the prompt relies
 * on for structure.
 */
function escapeStructuralTags(s) {
  // W7-1/W7-3: tolerate attribute-bearing tags (<review_batch batch_number="N">)
  // and preserve the opening-vs-closing slash distinction. The old `>`-anchored
  // regex missed attribute-bearing tags and the '<\\/$1>' replacement corrupted
  // opening tags into closing tags.
  return String(s ?? '').replace(
    /<(\/?)(diff|file|review_batch|untrusted_input)(?:\s[^>]*)?>/gi,
    '<\\/$1$2>',
  );
}

/**
 * Format one entry as the XML-ish block the prompt expects. The filename is
 * attribute-escaped and the patch body has its structural close-tags escaped so
 * a hostile filename/diff cannot break the prompt's structural boundary.
 */
export function formatEntry(entry) {
  const chunkLabel =
    entry.chunkCount > 1 ? ` part="${entry.chunkIndex}/${entry.chunkCount}"` : '';
  const safeName = escapeXmlAttribute(entry.filename);
  const safeStatus = escapeXmlAttribute(entry.status);
  const safePatch = escapeStructuralTags(entry.patch);
  return (
    `<file name="${safeName}" status="${safeStatus}"${chunkLabel}>\n` +
    `<diff>\n${safePatch}\n</diff>\n` +
    `</file>`
  );
}

/**
 * Pack entries into char+file-budgeted batches.
 *
 * Returns `{ entries, batches, metadata }`. Greedy packing: an entry is added
 * to the current batch unless doing so would exceed the char budget OR push
 * the distinct-file count over `maxFilesPerBatch`, in which case the current
 * batch is flushed first. A single oversized entry still gets its own batch.
 *
 * W15-A8-1: the per-batch char budget is `min(maxBatchChars, maxDiffChars)`
 * when `options.maxDiffChars > 0`. MAX_DIFF_CHARS is a documented hard cap
 * against cost abuse from oversized PRs, but the prompt-side truncation (W6-6
 * in buildStructuredReviewPrompt) is intentionally skipped whenever a batch
 * envelope is present — post-hoc truncation would silently drop entries
 * already counted in the batch metadata. Enforcing the cap HERE, at batch
 * construction, keeps the cap effective on the batched auto-review path
 * without breaking batch metadata. The oversized-single-entry guarantee is
 * preserved with the clamped budget: an entry larger than the budget still
 * forms its own batch.
 *
 * W16-B3-4: the per-batch clamp alone did NOT bound the TOTAL chars — a tiny
 * maxDiffChars with many files produced one batch per file (N API calls,
 * strictly worse than main) and the "hard cap against cost abuse" was still
 * unenforced. When maxDiffChars > 0, the CUMULATIVE packed chars across ALL
 * batches are capped: once the running total would exceed maxDiffChars, the
 * entry and every entry after it are NOT reviewed (dropping trailing entries,
 * mirroring the unbatched MAX_DIFF_CHARS semantics). One guard keeps the
 * oversized-entry semantics bounded: when the FIRST entry of a (fresh, empty)
 * batch exceeds only the REMAINING cumulative budget — and the budget is not
 * yet exhausted — it is still included as a single-entry batch, but ONLY if
 * its size fits the effective per-batch budget; an entry larger than even
 * that is never rescued. The total can therefore overshoot maxDiffChars by at
 * most one per-batch-budget-sized entry. Dropped entries are recorded in
 * metadata as `skippedEntries` / `skippedFiles` (present only when a drop
 * happened) so callers can surface the truncation. W17-C1-3: `skippedFiles`
 * counts only files with ZERO reviewed entries — a partially-reviewed file
 * (some chunks packed, some dropped) is not counted as skipped.
 */
export function createReviewBatches(files, options = {}) {
  const maxBatchChars = options.maxBatchChars || DEFAULTS.maxBatchChars;
  const maxFilesPerBatch = options.maxFilesPerBatch || DEFAULTS.maxFilesPerBatch;
  const entries = createReviewEntries(files, options);
  const maxDiffChars =
    typeof options.maxDiffChars === 'number' && options.maxDiffChars > 0
      ? options.maxDiffChars
      : 0;
  const charBudget = maxDiffChars > 0 ? Math.min(maxBatchChars, maxDiffChars) : maxBatchChars;

  const batches = [];
  let currentEntries = [];
  let currentChars = 0;
  let currentFiles = new Set();
  // W16-B3-4: cumulative packed chars across ALL batches + the drop record.
  let cumulativeChars = 0;
  let stopped = false;
  /** @type {Array<object>} */
  const skippedEntries = [];
  // W17-C1-3: filenames with at least one entry actually packed into a
  // batch. skippedFiles must count only files with ZERO reviewed entries —
  // a multi-chunk file whose first chunk was packed but whose later chunk
  // hit the cumulative cap is PARTIALLY reviewed, not skipped.
  const packedFiles = new Set();

  const flush = () => {
    if (currentEntries.length > 0) {
      batches.push(currentEntries);
      currentEntries = [];
      currentChars = 0;
      currentFiles = new Set();
    }
  };

  for (const entry of entries) {
    const entryLen = formatEntry(entry).length;
    if (stopped) {
      skippedEntries.push(entry);
      continue;
    }
    const nextDistinctFiles = currentFiles.has(entry.filename)
      ? currentFiles.size
      : currentFiles.size + 1;
    if (
      currentEntries.length > 0 &&
      (currentChars + entryLen > charBudget ||
        nextDistinctFiles > maxFilesPerBatch)
    ) {
      flush();
    }
    // W16-B3-4 cumulative cap (only when maxDiffChars > 0).
    if (maxDiffChars > 0 && cumulativeChars + entryLen > maxDiffChars) {
      const firstOfFreshBatch = currentEntries.length === 0;
      const fitsPerBatchBudget = entryLen <= charBudget;
      const budgetNotExhausted = cumulativeChars < maxDiffChars;
      if (!(firstOfFreshBatch && fitsPerBatchBudget && budgetNotExhausted)) {
        // Beyond the total cap and not rescuable as a bounded single-entry
        // batch: this entry and everything after it are NOT reviewed.
        stopped = true;
        skippedEntries.push(entry);
        continue;
      }
      // Single-entry tolerance: include it even though the cumulative total
      // overshoots (by at most one per-batch-budget-sized entry).
    }
    currentEntries.push(entry);
    currentChars += entryLen;
    currentFiles.add(entry.filename);
    cumulativeChars += entryLen;
    packedFiles.add(entry.filename);
  }
  flush();

  let splitFileCount = 0;
  const seen = new Set();
  for (const e of entries) {
    if (e.chunkCount > 1 && !seen.has(e.filename)) {
      splitFileCount++;
      seen.add(e.filename);
    }
  }

  const totalPatchableFiles = (files || []).filter(
    (f) => typeof f?.patch === 'string' && f.patch.length > 0,
  ).length;

  const metadata = {
    totalPatchableFiles,
    totalEntries: entries.length,
    splitFileCount,
    totalBatches: batches.length,
  };
  // W16-B3-4: expose the cumulative-cap drop ONLY when it happened, so the
  // field's presence is itself the truncation signal.
  if (skippedEntries.length > 0) {
    metadata.skippedEntries = skippedEntries.length;
    // W17-C1-3: count only files with ZERO reviewed entries. The old count
    // (`distinct filenames among dropped entries`) also counted partially-
    // reviewed files — a multi-chunk file with chunk 1 packed and chunk 2
    // dropped has dropped entries but WAS (partially) reviewed, and must not
    // be reported as skipped.
    const droppedFileNames = new Set(skippedEntries.map((e) => e.filename));
    let fullySkipped = 0;
    for (const name of droppedFileNames) {
      if (!packedFiles.has(name)) fullySkipped += 1;
    }
    metadata.skippedFiles = fullySkipped;
  }

  return { entries, batches, metadata };
}

/**
 * True when the patchable-files array length exceeds the large-PR threshold.
 */
export function isLargePr(patchableFiles, options = {}) {
  const threshold = options.largePrFileThreshold || DEFAULTS.largePrFileThreshold;
  return (patchableFiles || []).length > threshold;
}

/**
 * Detect context-length / token-cap errors from a variety of provider
 * message shapes. Used by executeStructuredBatch to decide whether to halve.
 */
export function isContextLimitError(error) {
  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('maximum context length') ||
    message.includes('input tokens exceeds') ||
    // W5-12: modern OpenAI/Z.ai error code string for context overflow.
    message.includes('context_length_exceeded') ||
    message.includes('code":413') ||
    message.includes('type":"413') ||
    message.includes('error 413')
  );
}

/* ------------------------------------------------------------------ *
 * Orchestration (stateful; network always injected via deps.callApi)
 * ------------------------------------------------------------------ */

const DEFAULT_CALL_API = () => {
  throw new Error('auto-review: callApi was not injected');
};

/**
 * Run `fn` over `items` with at most `concurrency` calls in flight at once.
 * Returns an array of results in the SAME ORDER as `items` — critical for
 * the structured-review pipeline, where batch order determines parse order,
 * which determines dedup "first wins". Completion order is irrelevant: even
 * if batch 5 finishes before batch 1, slot 1 holds batch 1's result.
 *
 * If any `fn` rejects, the error propagates (no swallowing). In-flight calls
 * are allowed to settle naturally (their rejections are ignored); the first
 * rejection wins and surfaces to the caller. The recursive-halving inside
 * executeStructuredBatch handles context-overflow on its own.
 *
 * Pure helper (no I/O of its own — `fn` does the I/O). Exported for testing.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency  max in-flight calls (clamped to ≥1)
 * @param {(item: T, index: number) => Promise<R>|R} fn
 * @returns {Promise<R[]>}
 */
export async function runWithConcurrency(items, concurrency, fn) {
  const list = Array.isArray(items) ? items : [];
  const limit = Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : 1;
  const results = new Array(list.length);

  let cursor = 0;
  let active = 0;
  // Abort flag: once any item rejects, stop launching NEW items so we don't
  // keep consuming resources (e.g. API credits) for a review that will fail.
  // Items already in flight still settle naturally.
  let aborted = false;

  return new Promise((resolve, reject) => {
    if (list.length === 0) {
      resolve(results);
      return;
    }

    const launchNext = () => {
      // Stop launching once we've hit the limit, run out of items, or aborted.
      while (active < limit && cursor < list.length && !aborted) {
        const i = cursor++;
        active++;
        let p;
        try {
          p = Promise.resolve(fn(list[i], i));
        } catch (err) {
          aborted = true;
          reject(err);
          return;
        }
        p.then(
          (val) => {
            results[i] = val; // slot by index → preserves input order
            active--;
            if (cursor < list.length) {
              launchNext();
            } else if (active === 0) {
              resolve(results);
            }
          },
          (err) => {
            // First rejection wins; subsequent rejects are swallowed. Set the
            // abort flag so success handlers from other in-flight items don't
            // launch yet more items.
            aborted = true;
            reject(err);
          },
        );
      }
    };

    launchNext();
  });
}

/**
 * Review one batch of entries via the structured prompt, recursively halving
 * on context-overflow. Returns an array of raw model-text strings (one per
 * successful callApi invocation — halving produces multiple).
 *
 * @param {Array} entries  - the batch's review entries
 * @param {Object} state   - { apiKey, model, batchNumber, totalBatches, maxFindings?, scannerContext?, pathInstructions?, toneInstructions?, maxDiffChars?, learningsContext? }
 * @param {Object} deps    - { callApi, buildStructuredReviewPrompt, core }
 * @returns {Promise<string[]>} raw model-text strings
 */
export async function executeStructuredBatch(entries, state, deps = {}) {
  const callApi = deps.callApi || DEFAULT_CALL_API;
  const buildPrompt = deps.buildStructuredReviewPrompt || buildStructuredReviewPrompt;
  const core = deps.core;

  const prompt = buildPrompt(
    entries.map((e) => ({ filename: e.filename, status: e.status, patch: e.patch })),
    {
      batchNumber: state.batchNumber,
      totalBatches: state.totalBatches,
      maxFindings: state.maxFindings,
      scannerContext: state.scannerContext,
      pathInstructions: state.pathInstructions,
      toneInstructions: state.toneInstructions,
      maxDiffChars: state.maxDiffChars,
      learningsContext: state.learningsContext,
    },
  );

  try {
    const raw = await callApi(state.apiKey, state.model, prompt);
    return [raw];
  } catch (error) {
    if (!isContextLimitError(error) || !entries.length) {
      throw error;
    }
    if (entries.length === 1) {
      // Single entry overflows context — skip it rather than abort the whole
      // review. Rethrowing here would propagate through runWithConcurrency and
      // cancel every other batch; returning an empty findings array lets the
      // caller still get results for the remaining batches.
      return [];
    }
    const mid = Math.ceil(entries.length / 2);
    const left = entries.slice(0, mid);
    const right = entries.slice(mid);
    if (core?.info) {
      core.info(
        `Context limit hit on batch ${state.batchNumber} (${entries.length} entries); ` +
          `halving into ${left.length} + ${right.length}.`,
      );
    }
    const [leftResults, rightResults] = await Promise.all([
      executeStructuredBatch(left, state, deps),
      executeStructuredBatch(right, state, deps),
    ]);
    return [...leftResults, ...rightResults];
  }
}

/**
 * Run the structured review pipeline: build batches, review each batch
 * (structured JSON output), parse findings, merge across batches, rank+cap.
 *
 * Flow:
 *   1. createReviewBatches(files, reviewConfig) → {batches, metadata}
 *   2. For each batch, executeStructuredBatch → raw-text strings (halving on
 *      context overflow may produce multiple per batch).
 *   3. parseStructuredReview(rawText, {changedFiles}) → {summary, findings}.
 *      The last non-empty summary wins (batches are reviewed in order; the
 *      final batch's summary is the most complete picture).
 *   4. mergeFindings(allLLMFindings, deterministicFindings) — deterministic
 *      scanner findings supersede LLM findings at the same file:line+title.
 *   5. rankAndCapFindings(merged, {maxFindings, minSeverity}) → final capped.
 *   6. Return {findings, summary, metadata}.
 *
 * @param {Array} files - raw changed files (each {filename, status, patch?, ...})
 * @param {Object} config - { apiKey, model, maxBatchChars, maxFilesPerBatch, maxPatchChars, maxFindings, minSeverity, deterministicFindings?, scannerContext?, pathInstructions?, toneInstructions?, maxDiffChars?, learningsContext? }
 * @param {Object} deps - { callApi, createReviewBatches, parseStructuredReview, rankAndCapFindings, mergeFindings, buildStructuredReviewPrompt, executeStructuredBatch, core }
 * @returns {Promise<{findings: Array, summary: string, metadata: Object}>}
 */
export async function runStructuredReview(files, config, deps = {}) {
  const callApi = deps.callApi || DEFAULT_CALL_API;
  const buildBatches = deps.createReviewBatches || createReviewBatches;
  const parseReview = deps.parseStructuredReview || parseStructuredReview;
  const rankAndCap = deps.rankAndCapFindings || rankAndCapFindings;
  const merge = deps.mergeFindings || mergeFindings;
  const executeBatch = deps.executeStructuredBatch || executeStructuredBatch;
  const core = deps.core;

  // Empty input short-circuit: no batches, no callApi, empty result.
  if (!Array.isArray(files) || files.length === 0) {
    return {
      findings: [],
      summary: '',
      metadata: {
        totalBatches: 0,
        totalFindingsBeforeCap: 0,
        deterministicFindingsCount: 0,
        batchMetadata: [],
      },
    };
  }

  const reviewConfig = {
    maxBatchChars: config.maxBatchChars || DEFAULTS.maxBatchChars,
    maxFilesPerBatch: config.maxFilesPerBatch || DEFAULTS.maxFilesPerBatch,
    maxPatchChars: config.maxPatchChars || DEFAULTS.maxPatchChars,
    // W15-A8-1: MAX_DIFF_CHARS must bind at batch construction (the prompt-side
    // W6-6 truncation is skipped whenever batched, so the cap is enforced by
    // clamping each batch's char budget to min(maxBatchChars, maxDiffChars)
    // inside createReviewBatches).
    maxDiffChars: typeof config.maxDiffChars === 'number' ? config.maxDiffChars : 0,
  };

  const batchState = {
    apiKey: config.apiKey,
    model: config.model,
    maxFindings: config.maxFindings,
    scannerContext: config.scannerContext,
    pathInstructions: config.pathInstructions,
    toneInstructions: config.toneInstructions,
    maxDiffChars: config.maxDiffChars,
    learningsContext: config.learningsContext,
  };

  const { batches, metadata: batchMetadata } = buildBatches(files, reviewConfig);

  // W16-B3-4: surface the cumulative maxDiffChars drop (if any) on the result
  // metadata, the same way totalFindingsBeforeCap/deterministicFindingsCount
  // are exposed — index.js assembles its reviewMetadata from result.metadata
  // and can render the skip note later without touching this module.
  const skippedMeta =
    typeof batchMetadata.skippedFiles === 'number' && batchMetadata.skippedFiles > 0
      ? {
          skippedFiles: batchMetadata.skippedFiles,
          skippedEntries: batchMetadata.skippedEntries,
        }
      : {};
  if (core?.info && skippedMeta.skippedFiles) {
    core.info(
      `Structured review: maxDiffChars cap dropped ${skippedMeta.skippedFiles} file(s) ` +
        `(${skippedMeta.skippedEntries} chunk(s) unreviewed).`,
    );
  }

  // Bounded concurrent fan-out (Phase 6.1). Batches run with up to
  // `batchConcurrency` calls in flight at once. runWithConcurrency returns
  // results in INPUT order, so the downstream parse/merge/dedup stays
  // deterministic regardless of completion order (dedup "first wins" by
  // batch index). If any batch rejects, the error propagates — recursive
  // halving inside executeStructuredBatch handles context-overflow on its own.
  const concurrency = Math.max(1, Math.min(config.batchConcurrency || 3, 8));
  const totalBatches = batches.length;
  const batchRawTexts = await runWithConcurrency(batches, concurrency, async (batch, i) => {
    return executeBatch(
      batch,
      { ...batchState, batchNumber: i + 1, totalBatches },
      { callApi, core },
    );
  });

  /** @type {Record<string, unknown>[]} */
  const allFindings = [];
  const batchMeta = [];
  let summary = '';

  // Parse + merge in batch order (deterministic — order preserved by
  // runWithConcurrency). The last non-empty summary wins.
  for (let i = 0; i < batchRawTexts.length; i++) {
    const rawTexts = batchRawTexts[i];
    const batchNumber = i + 1;
    let batchFindingCount = 0;
    for (const raw of rawTexts) {
      const parsed = parseReview(raw, { changedFiles: files });
      if (parsed.summary && parsed.summary.length > 0) {
        summary = parsed.summary;
      }
      for (const f of parsed.findings) {
        allFindings.push(f);
        batchFindingCount++;
      }
    }
    batchMeta.push({
      batchNumber,
      rawTextCount: rawTexts.length,
      findingCount: batchFindingCount,
    });
  }

  const deterministicFindings = Array.isArray(config.deterministicFindings)
    ? config.deterministicFindings
    : [];
  const merged = merge(allFindings, deterministicFindings);

  const totalFindingsBeforeCap = merged.length;
  const maxFindings =
    typeof config.maxFindings === 'number' && config.maxFindings > 0
      ? config.maxFindings
      : DEFAULTS.maxFindings;
  const minSeverity =
    typeof config.minSeverity === 'string' && config.minSeverity.length > 0
      ? config.minSeverity
      : DEFAULTS.minSeverity;

  const findings = rankAndCap(merged, { maxFindings, minSeverity });

  if (core?.info && findings.length < totalFindingsBeforeCap) {
    core.info(
      `Structured review: ${totalFindingsBeforeCap - findings.length} findings truncated to cap (${findings.length}/${maxFindings}).`,
    );
  }

  return {
    findings,
    summary,
    metadata: {
      totalBatches: batches.length,
      totalFindingsBeforeCap,
      deterministicFindingsCount: deterministicFindings.length,
      batchMetadata: batchMeta,
      splitFileCount: batchMetadata.splitFileCount,
      ...skippedMeta,
    },
  };
}
