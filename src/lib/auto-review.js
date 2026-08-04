/**
 * Auto-review pipeline: risk-scored batching + synthesis.
 *
 * This is the fork's single best engineering idea. Instead of lossily
 * truncating a large PR (the upstream's only strategy), this module:
 *   1. risk-scores each changed file (size + status + path patterns),
 *   2. line-split big patches into char-budgeted chunks,
 *   3. packs the resulting entries into char+file-budgeted batches
 *      (highest-risk first),
 *   4. reviews each batch via an INJECTED `callApi`,
 *   5. synthesizes the per-batch reviews into one final review (again via
 *      the injected `callApi`), and
 *   6. on a context-overflow error from a batch, recursively halves that
 *      batch until each half fits.
 *
 * Two layers, on purpose:
 *   - PURE pipeline (`scoreFile`, `splitTextByLines`, `createReviewEntries`,
 *     `createReviewBatches`, `formatEntry`, `buildBatchPrompt`,
 *     `buildCoverageNotes`, `buildSynthesisPrompt`, `buildFallbackReview`,
 *     `isLargePr`, `isContextLimitError`). No I/O. Deterministic. Tested
 *     exhaustively.
 *   - ORCHESTRATION (`executeReviewBatch`, `runAutoReview`). Stateful, but
 *     the network is ALWAYS injected via `deps.callApi` — production wires
 *     it to api.js's client, tests pass a fake. This module never touches
 *     the network directly, which keeps it testable and makes api.js the
 *     single transport.
 *
 * @module src/lib/auto-review.js
 */

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
  synthesisMaxChars: 120000,
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
 * Format one entry as the XML-ish block the prompt expects.
 */
export function formatEntry(entry) {
  const chunkLabel =
    entry.chunkCount > 1 ? ` part="${entry.chunkIndex}/${entry.chunkCount}"` : '';
  return (
    `<file name="${entry.filename}" status="${entry.status}"${chunkLabel}>\n` +
    `<diff>\n${entry.patch}\n</diff>\n` +
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
 * The per-batch review prompt. `batchNumber` is 1-indexed.
 */
export function buildBatchPrompt(entries, options = {}) {
  const batchNumber = options.batchNumber || 1;
  const totalBatches = options.totalBatches || 1;
  const totalFiles = new Set(entries.map((e) => e.filename)).size;
  const formattedFiles = entries.map(formatEntry).join('\n\n');
  return (
    `Please review the following Pull Request changes based on your system instructions.\n\n` +
    `This is batch ${batchNumber} of ${totalBatches}. Review all files in this batch thoroughly, ` +
    `but do not assume the rest of the PR is included here. Focus on concrete bugs, security issues, ` +
    `risky logic, and architecture mismatches visible in these diffs.\n\n` +
    `<review_batch file_count="${totalFiles}" chunk_count="${entries.length}" ` +
    `batch_number="${batchNumber}" total_batches="${totalBatches}">\n` +
    `${formattedFiles}\n` +
    `</review_batch>`
  );
}

/**
 * Build the coverage-notes bullet lines from synthesis metadata.
 */
export function buildCoverageNotes(metadata) {
  const {
    reviewedFiles = 0,
    totalBatches = 0,
    splitFileCount = 0,
    limitReached = false,
  } = metadata || {};
  const notes = [
    `Reviewed ${reviewedFiles} file(s) across ${totalBatches} batch(es).`,
  ];
  if (splitFileCount > 0) {
    notes.push(`${splitFileCount} large file(s) were split across multiple review parts.`);
  }
  if (limitReached) {
    notes.push(
      'The total diff exceeded the configured cap; some changes may be summarized rather than reviewed line-by-line.',
    );
  }
  return notes;
}

/**
 * Build the synthesis prompt. Joins per-batch reviews under `## Batch N`
 * headers (truncated to synthesisMaxChars FIRST), prepends a coverage
 * summary as bullets, and instructs the model to produce the fixed
 * markdown section structure with a Rating.
 */
export function buildSynthesisPrompt(collectedReviews, metadata) {
  const synthesisMaxChars = DEFAULTS.synthesisMaxChars;
  const joined =
    collectedReviews
      .map((r, i) => `## Batch ${i + 1}\n\n${r.review}`)
      .join('\n\n---\n\n') || '';
  const truncated =
    joined.length > synthesisMaxChars
      ? joined.slice(0, synthesisMaxChars)
      : joined;

  const coverageBullets = buildCoverageNotes(metadata)
    .map((n) => `- ${n}`)
    .join('\n');

  const instruction = [
    'You are the senior synthesizer for an automated code review.',
    'Several per-batch reviews of one pull request follow, each covering a disjoint slice of the diff.',
    'Produce ONE coherent, deduplicated review that preserves every concrete bug, security issue, and meaningful suggestion raised across all batches — but merges overlaps and removes redundancy.',
    '',
    'Your response MUST use this exact markdown structure (omit any section that has no content, except for Review Summary and Final Assessment, which are always present):',
    '',
    '## Review Summary',
    '<2-4 sentence high-level overview of the change quality and risk.>',
    '',
    '## Critical Issues & Bugs',
    '<concrete bugs, security issues, risky logic — one bullet per issue, with file references where known. Omit if none.>',
    '',
    '## Suggestions & Best Practices',
    '<non-blocking improvements — one bullet per suggestion. Omit if none.>',
    '',
    '## Coverage Notes',
    '<what was and was not covered, including any files split across review parts or any cap that was reached.>',
    '',
    '## Final Assessment',
    'Rating: <one of Good | Normal | Very Bad>',
    '<one short sentence justifying the rating.>',
  ].join('\n');

  return (
    `${instruction}\n\n` +
    `## Coverage Summary\n${coverageBullets}\n\n` +
    `## Per-Batch Reviews\n\n${truncated}`
  );
}

/**
 * Build the fallback review (no API call) used when synthesis fails.
 * Concatenates per-batch reviews under `### Batch N` headers and prepends a
 * note that synthesis was unavailable.
 */
export function buildFallbackReview(collectedReviews, metadata) {
  const coverageBullets = buildCoverageNotes(metadata)
    .map((n) => `- ${n}`)
    .join('\n');
  const perBatch = collectedReviews
    .map((r, i) => `### Batch ${i + 1}\n\n${r.review}`)
    .join('\n\n');
  return (
    `> Note: Automated synthesis was unavailable for this review, so the per-batch reviews are shown below without deduplication.\n\n` +
    `## Coverage Notes\n${coverageBullets}\n\n` +
    `## Per-Batch Reviews\n\n${perBatch}`
  );
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
 * message shapes. Used by executeReviewBatch to decide whether to halve.
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
 * Review one batch of entries, recursively halving on context-overflow.
 *
 * @param {Array} entries  - the batch's review entries
 * @param {Object} state   - { apiKey, model, batchNumber, totalBatches }
 * @param {Object} deps    - { callApi, buildBatchPrompt, core }
 * @returns {Promise<Array<{review, coverage}>>}
 */
export async function executeReviewBatch(entries, state, deps = {}) {
  const callApi = deps.callApi || DEFAULT_CALL_API;
  const buildBatch = deps.buildBatchPrompt || buildBatchPrompt;
  const core = deps.core;

  const prompt = buildBatch(entries, {
    batchNumber: state.batchNumber,
    totalBatches: state.totalBatches,
  });

  try {
    const review = await callApi(state.apiKey, state.model, prompt);
    return [
      {
        review,
        coverage: {
          batchNumber: state.batchNumber,
          entryCount: entries.length,
          fileCount: new Set(entries.map((e) => e.filename)).size,
        },
      },
    ];
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
      executeReviewBatch(left, state, deps),
      executeReviewBatch(right, state, deps),
    ]);
    return [...leftResults, ...rightResults];
  }
}

/**
 * Run the full pipeline: build batches, review each, synthesize.
 *
 * @param {Array} files    - raw changed files
 * @param {Object} config  - { apiKey, model, maxBatchChars, maxFilesPerBatch, maxPatchChars, ... }
 * @param {Object} deps    - { callApi, createReviewBatches, buildSynthesisPrompt, buildFallbackReview, buildCoverageNotes, core }
 * @returns {Promise<string>} the final review text
 */
export async function runAutoReview(files, config, deps = {}) {
  const callApi = deps.callApi || DEFAULT_CALL_API;
  const buildBatches = deps.createReviewBatches || createReviewBatches;
  const buildSynth = deps.buildSynthesisPrompt || buildSynthesisPrompt;
  const buildFallback = deps.buildFallbackReview || buildFallbackReview;
  const buildNotes = deps.buildCoverageNotes || buildCoverageNotes;
  const core = deps.core;

  const reviewConfig = {
    maxBatchChars: config.maxBatchChars || DEFAULTS.maxBatchChars,
    maxFilesPerBatch: config.maxFilesPerBatch || DEFAULTS.maxFilesPerBatch,
    maxPatchChars: config.maxPatchChars || DEFAULTS.maxPatchChars,
  };
  const state = {
    apiKey: config.apiKey,
    model: config.model,
    reviewConfig,
    limitReached: Boolean(config.limitReached),
  };

  const { batches, metadata } = buildBatches(files, state.reviewConfig);

  const collectedReviews = [];
  for (let i = 0; i < batches.length; i++) {
    const batchNumber = i + 1;
    const results = await executeReviewBatch(
      batches[i],
      { apiKey: state.apiKey, model: state.model, batchNumber, totalBatches: batches.length },
      deps,
    );
    for (const r of results) collectedReviews.push(r);
  }

  const reviewedFiles = new Set(
    (files || []).filter((f) => f.patch).map((f) => f.filename),
  ).size;
  const synthesisMetadata = {
    reviewedFiles,
    totalBatches: collectedReviews.length,
    splitFileCount: metadata.splitFileCount,
    limitReached: state.limitReached,
  };

  try {
    const synthPrompt = buildSynth(collectedReviews, synthesisMetadata);
    const synthesized = await callApi(state.apiKey, state.model, synthPrompt);
    // Append/section the coverage notes.
    const notes = buildNotes(synthesisMetadata);
    if (synthesized.includes('## Coverage Notes')) {
      const bullets = '\n' + notes.map((n) => `- ${n}`).join('\n');
      return synthesized + bullets;
    }
    return (
      synthesized +
      '\n\n## Coverage Notes\n' +
      notes.map((n) => `- ${n}`).join('\n')
    );
  } catch (error) {
    if (core?.warning) {
      core.warning(
        `Auto-review synthesis failed (${error?.message || error}); returning concatenated per-batch reviews.`,
      );
    }
    return buildFallback(collectedReviews, synthesisMetadata);
  }
}
