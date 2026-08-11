/**
 * Deterministic diff metrics (PURE — no I/O, no deps).
 *
 * Computes a small set of high-signal metrics about a PR's changed-files array:
 * counts, additions/deletions, test-vs-source classification, large/generated
 * file heuristics, and a TODO/FIXME counter over ADDED diff lines. These feed
 * two consumers:
 *   1. `metricsToFindings` surfaces large/generated files as low-severity
 *      deterministic findings (consumed by the LLM-merge path).
 *   2. `formatMetricsForPrompt` renders a compact "PR metrics" block that is
 *      injected into the LLM prompt as context.
 *
 * The input shape matches the GitHub PR `files` payload: each entry has
 * `{filename, status, additions?, deletions?, changes?, patch?}`. Only
 * `filename` is required; everything else is best-effort.
 *
 * @module src/lib/scanners/metrics.js
 */

import { parseAddedLines } from './_patch.js';

/** Source-code extensions used to classify a file as a source file. */
const SOURCE_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'svelte', 'astro',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'scala',
  'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'hxx',
  'cs', 'fs', 'vb',
  'php', 'pl', 'pm',
  'swift', 'm', 'mm',
  'sh', 'bash', 'zsh', 'fish',
  'sql', 'graphql', 'gql',
  'yml', 'yaml',
  'json', 'toml', 'ini', 'cfg',
]);

/** Glob-style test-file patterns. A filename matching any → test file. */
const TEST_PATTERNS = [
  /\.test\.[^.]+$/, // foo.test.js
  /\.spec\.[^.]+$/, // foo.spec.ts
  /(^|\/)__tests__\//, // __tests__/foo.js
  /(^|\/)tests?\//, // tests/foo.js, test/foo.js
  /(^|\/)__mocks__\//, // __mocks__/foo.js
  /(^|\/)fixtures\//, // fixtures/foo.js
];

/** Glob-style generated-file patterns. */
const GENERATED_PATTERNS = [
  /\.lock$/, // any .lock file
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /\.generated\.[^.]+$/, // foo.generated.js
  /(^|\/)dist\//, // dist/*
  /(^|\/)build\//, // build/*
  /\.min\.[^.]+$/, // foo.min.js
];

/** Threshold (in changed lines) above which a file is "large". */
const LARGE_FILE_THRESHOLD = 300;

/** Markers counted in added diff lines for the TODO/FIXME/etc. tally. */
const TODO_MARKERS = ['TODO', 'FIXME', 'HACK', 'XXX'];
/**
 * Precompiled word-boundary regexes for each TODO marker. Using `\b` prevents
 * substring false-positives like "XXXL", "XXX chromosome", or "FIXMEable".
 * Built once at module load.
 */
const TODO_MARKER_RES = TODO_MARKERS.map((m) => new RegExp(`\\b${m}\\b`));

/**
 * Extract the file extension (lowercased, no dot) from a filename.
 * Returns `''` for dotfiles / no extension.
 *
 * @param {string} filename
 * @returns {string}
 */
function extOf(filename) {
  if (typeof filename !== 'string' || filename.length === 0) return '';
  const base = filename.split('/').pop() || filename;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return ''; // dotfiles (.eslintrc) have no ext
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Is this filename a test file? (matches TEST_PATTERNS)
 *
 * @param {string} filename
 * @returns {boolean}
 */
export function isTestFile(filename) {
  if (typeof filename !== 'string') return false;
  return TEST_PATTERNS.some((re) => re.test(filename));
}

/**
 * Is this filename a source file? (recognized source extension AND not a test)
 *
 * @param {string} filename
 * @returns {boolean}
 */
export function isSourceFile(filename) {
  if (typeof filename !== 'string') return false;
  if (isTestFile(filename)) return false;
  return SOURCE_EXTENSIONS.has(extOf(filename));
}

/**
 * Is this filename a generated/lockfile?
 *
 * @param {string} filename
 * @returns {boolean}
 */
export function isGeneratedFile(filename) {
  if (typeof filename !== 'string') return false;
  return GENERATED_PATTERNS.some((re) => re.test(filename));
}

/**
 * Count TODO/FIXME/HACK/XXX markers in the ADDED lines of a unified diff patch.
 * Delegates to {@link parseAddedLines} so the line filter (which hunk lines are
 * real additions vs. pre-hunk diff metadata) stays in one place. Markers are
 * matched with word boundaries (`\b`) so that substrings like "XXXL" or
 * "XXX chromosome" do NOT count; an added line with multiple markers counts once.
 *
 * Returns 0 for non-string / empty patches.
 *
 * @param {string} patch
 * @returns {number}
 */
export function countTodosInPatch(patch) {
  if (!patch) return 0;
  const additions = parseAddedLines(patch);
  let count = 0;
  for (const a of additions) {
    if (TODO_MARKER_RES.some((re) => re.test(a.text))) count++;
  }
  return count;
}

/**
 * Compute deterministic diff metrics over a PR's changed-files array.
 *
 * Each input entry: `{filename, status, additions?, deletions?, changes?, patch?}`.
 * Only `filename` is required; the numeric fields default to 0 when absent or
 * non-finite; the patch is used only for the TODO tally (best-effort).
 *
 * @param {Array<{filename?: string, status?: string, additions?: number, deletions?: number, changes?: number, patch?: string}>} files
 * @returns {{
 *   filesChanged: number,
 *   additions: number,
 *   deletions: number,
 *   testFiles: number,
 *   sourceFiles: number,
 *   testToSourceRatio: number,
 *   largeFiles: string[],
 *   generatedFiles: string[],
 *   todoCount: number,
 *   byStatus: Record<string, number>,
 * }}
 */
export function computeMetrics(files) {
  const out = {
    filesChanged: 0,
    additions: 0,
    deletions: 0,
    testFiles: 0,
    sourceFiles: 0,
    testToSourceRatio: 0,
    largeFiles: [],
    generatedFiles: [],
    todoCount: 0,
    // W11-6: use a null-prototype object so status strings like "__proto__" or
    // "constructor" cannot corrupt the counter via the inherited prototype.
    byStatus: Object.create(null),
  };
  if (!Array.isArray(files)) return out;

  for (const f of files || []) {
    if (!f || typeof f !== 'object') continue;
    const filename = typeof f.filename === 'string' ? f.filename : '';
    if (!filename) continue;
    out.filesChanged += 1;

    const additions = Number.isFinite(f.additions) ? Math.max(0, Math.floor(f.additions)) : 0;
    const deletions = Number.isFinite(f.deletions) ? Math.max(0, Math.floor(f.deletions)) : 0;
    // W11-5: `changes` from GitHub is additions+deletions, but a malformed or
    // stale payload can report a value smaller than the true diff size. Use the
    // reported value only when it is at least as large as additions+deletions,
    // so the large-file check reflects the real diff footprint either way.
    const reported = Number.isFinite(f.changes) ? Math.max(0, Math.floor(f.changes)) : 0;
    const changes = Math.max(reported, additions + deletions);

    out.additions += additions;
    out.deletions += deletions;

    if (isTestFile(filename)) out.testFiles += 1;
    else if (isSourceFile(filename)) out.sourceFiles += 1;

    if (changes > LARGE_FILE_THRESHOLD) out.largeFiles.push(filename);
    if (isGeneratedFile(filename)) out.generatedFiles.push(filename);

    out.todoCount += countTodosInPatch(typeof f.patch === 'string' ? f.patch : '');

    const status = typeof f.status === 'string' && f.status.length > 0 ? f.status : 'modified';
    // W11-6: a status of "__proto__" or "constructor" would corrupt the counter
    // via prototype pollution on a plain `{}`. Use Object.hasOwn to read the
    // own-property count, never the inherited value.
    const prev = Object.hasOwn(out.byStatus, status) ? out.byStatus[status] : 0;
    out.byStatus[status] = prev + 1;
  }

  out.testToSourceRatio = out.sourceFiles > 0 ? out.testFiles / out.sourceFiles : 0;
  return out;
}

/**
 * Render a compact one-line "PR metrics" string for prompt injection.
 *
 * Example: `12 files (+340 -89), test-to-source ratio 0.30, 2 large files, 4 TODOs.`
 *
 * @param {ReturnType<typeof computeMetrics>} metrics
 * @returns {string}
 */
export function formatMetricsForPrompt(metrics) {
  if (!metrics || typeof metrics !== 'object') return '';
  const files = metrics.filesChanged || 0;
  const adds = metrics.additions || 0;
  const dels = metrics.deletions || 0;
  const ratio = Number.isFinite(metrics.testToSourceRatio)
    ? metrics.testToSourceRatio
    : 0;
  const large = (metrics.largeFiles || []).length;
  const todos = metrics.todoCount || 0;
  return (
    `${files} files (+${adds} -${dels}), ` +
    `test-to-source ratio ${ratio.toFixed(2)}, ` +
    `${large} large file${large === 1 ? '' : 's'}, ` +
    `${todos} TODO${todos === 1 ? '' : 's'}.`
  );
}

/**
 * Surface large/generated files as low-severity findings. The LLM merge path
 * dedups against model findings at the same file+line+title, so these are
 * strictly additive context.
 *
 * Each finding:
 *   - large file  → severity 'info', category 'maintainability'
 *   - generated file → severity 'info', category 'maintainability'
 *
 * Returns an empty array when no large/generated files were detected.
 *
 * @param {ReturnType<typeof computeMetrics>} metrics
 * @returns {Array<Record<string, unknown>>}
 */
export function metricsToFindings(metrics) {
  if (!metrics || typeof metrics !== 'object') return [];
  /** @type {Record<string, unknown>[]} */
  const out = [];
  for (const filename of metrics.largeFiles || []) {
    out.push({
      file: filename,
      line: null,
      severity: 'info',
      confidence: 'high',
      category: 'maintainability',
      title: 'Large file change',
      description:
        'This file has a large diff (>300 changed lines). Consider splitting into smaller reviews.',
      evidence: '',
      suggestion: 'Break the change into smaller, independently reviewable commits.',
      rule: 'metrics:large-file',
    });
  }
  for (const filename of metrics.generatedFiles || []) {
    out.push({
      file: filename,
      line: null,
      severity: 'info',
      confidence: 'high',
      category: 'maintainability',
      title: 'Generated/lock file modified',
      description:
        'This file is typically generated (lockfile, build output, or .generated. file). ' +
        'Reviewing it line-by-line is rarely useful.',
      evidence: '',
      suggestion: null,
      rule: 'metrics:generated-file',
    });
  }
  return out;
}
