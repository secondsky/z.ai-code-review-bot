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
      for (let i = 0; i < line.length; i += maxChars) {
        chunks.push(line.slice(i, i + maxChars));
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
 * Escape structural XML close-tags inside patch bodies so an attacker cannot
 * inject `</diff>`, `</file>`, or `</review_batch>` to break out of the
 * wrapping boundary the prompt relies on for structure.
 */
function escapeStructuralTags(s) {
  return String(s ?? '').replace(/<\/(diff|file|review_batch|untrusted_input)>/gi, '<\\/$1>');
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
 * to the current batch unless doing so would exceed `maxBatchChars` OR push
 * the distinct-file count over `maxFilesPerBatch`, in which case the current
 * batch is flushed first. A single oversized entry still gets its own batch.
 */
export function createReviewBatches(files, options = {}) {
  const maxBatchChars = options.maxBatchChars || DEFAULTS.maxBatchChars;
  const maxFilesPerBatch = options.maxFilesPerBatch || DEFAULTS.maxFilesPerBatch;
  const entries = createReviewEntries(files, options);

  const batches = [];
  let currentEntries = [];
  let currentChars = 0;
  let currentFiles = new Set();

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
    const nextDistinctFiles = currentFiles.has(entry.filename)
      ? currentFiles.size
      : currentFiles.size + 1;
    if (
      currentEntries.length > 0 &&
      (currentChars + entryLen > maxBatchChars ||
        nextDistinctFiles > maxFilesPerBatch)
    ) {
      flush();
    }
    currentEntries.push(entry);
    currentChars += entryLen;
    currentFiles.add(entry.filename);
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
    message.includes('code":413') ||
    message.includes('type":"413')
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

  return new Promise((resolve, reject) => {
    if (list.length === 0) {
      resolve(results);
      return;
    }

    const launchNext = () => {
      // Stop launching once we've hit the limit or run out of items.
      while (active < limit && cursor < list.length) {
        const i = cursor++;
        active++;
        let p;
        try {
          p = Promise.resolve(fn(list[i], i));
        } catch (err) {
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
            // First rejection wins; subsequent rejects are swallowed.
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
    if (
      !isContextLimitError(error) ||
      !entries.length ||
      entries.length === 1
    ) {
      throw error;
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
    },
  };
}
