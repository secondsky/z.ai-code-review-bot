/**
 * Structured-findings schema (v2).
 *
 * The bot historically emitted free-form markdown reviews. v2 replaces that with
 * a strict structured-findings schema so findings can be validated, deduplicated,
 * ranked, capped, merged with deterministic scanner output, mapped to diff
 * lines (Phase 2), and rendered as an idempotent summary comment.
 *
 * This module is PURE (no I/O, no imports of other project modules). Every
 * function is exported so the unit tests in `tests/findings.test.js` can pin
 * each contract independently.
 *
 * @module src/lib/findings.js
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Allowed-value tables (exported verbatim — the schema contract).
// ---------------------------------------------------------------------------

/** @type {ReadonlyArray<string>} */
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];

/** @type {ReadonlyArray<string>} */
export const CONFIDENCES = ['high', 'medium', 'low'];

/** @type {ReadonlyArray<string>} */
export const CATEGORIES = [
  'bug',
  'security',
  'performance',
  'maintainability',
  'style',
  'test',
  'docs',
];

/**
 * Severity -> numeric rank for ordering. Lower rank sorts first.
 * @type {Readonly<Record<string, number>>}
 */
export const SEVERITY_RANK = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

/**
 * Confidence -> numeric rank for tie-breaking. Lower rank sorts first.
 * @type {Readonly<Record<string, number>>}
 */
const CONFIDENCE_RANK = {
  high: 0,
  medium: 1,
  low: 2,
};

/** Hard limit on the `title` field. Titles longer than this get truncated. */
const TITLE_MAX = 120;

/** When a title is truncated, the suffix we append (so result length == 120). */
const TITLE_TRUNC_SUFFIX = '...';

/**
 * The exact set of keys a normalized finding carries. Anything else on the
 * input object is dropped. Exported indirectly via `normalizeFinding`'s output.
 * @type {ReadonlyArray<string>}
 */
const SCHEMA_KEYS = [
  'file',
  'line',
  'severity',
  'confidence',
  'category',
  'title',
  'description',
  'evidence',
  'suggestion',
  'rule',
];

/** Idempotency marker reused from comments.js — must remain byte-exact. */
const MARKER = '<!-- zai-code-review -->';

/** Per-severity emoji for the summary renderer. */
const SEVERITY_EMOJI = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🔵',
  info: '➖',
};

/** Per-severity display label. */
const SEVERITY_LABEL = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Case-insensitively coerce `value` to the canonical casing of an entry in
 * `allowed`. Returns the canonical entry on match, or `null` if no match.
 *
 * @param {unknown} value
 * @param {ReadonlyArray<string>} allowed
 * @returns {string | null}
 */
function coerceEnum(value, allowed) {
  if (typeof value !== 'string') return null;
  // W7-2: trim incidental whitespace. LLMs commonly emit "critical " (trailing
  // space) which would otherwise fail the exact match and silently drop the
  // finding — losing exactly the severe findings the bot exists to surface.
  const lower = value.trim().toLowerCase();
  for (const candidate of allowed) {
    if (candidate === lower) return candidate;
  }
  return null;
}

/**
 * Is `value` a positive (>=1) integer? (`0` is NOT a valid 1-based line.)
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/**
 * Validate a single finding object against the schema.
 *
 * Rules:
 *   - `file` must be a non-empty string.
 *   - `line` must be a positive integer OR `null`.
 *   - `severity` must be in {@link SEVERITIES} (case-insensitive).
 *   - `confidence` must be in {@link CONFIDENCES} (case-insensitive).
 *   - `category` must be in {@link CATEGORIES} (case-insensitive).
 *   - `title` must be a non-empty string of <= {@link TITLE_MAX} chars.
 *   - `description` must be a non-empty string.
 *   - `evidence` must be a string (empty allowed).
 *   - `suggestion` must be a string OR `null`.
 *   - `rule` must be a string OR `null`.
 *
 * Missing fields error. Extra fields are ignored (don't error).
 *
 * @param {unknown} finding
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateFinding(finding) {
  const errors = [];
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
    return { ok: false, errors: ['finding must be an object'] };
  }
  const f = /** @type {Record<string, unknown>} */ (finding);

  if (typeof f.file !== 'string' || f.file.length === 0) {
    errors.push('file must be a non-empty string');
  }

  // `line` may be null OR a positive integer.
  if (f.line !== null && !isPositiveInteger(f.line)) {
    errors.push('line must be a positive integer or null');
  }

  if (coerceEnum(f.severity, SEVERITIES) === null) {
    errors.push(`severity must be one of: ${SEVERITIES.join(', ')}`);
  }
  if (coerceEnum(f.confidence, CONFIDENCES) === null) {
    errors.push(`confidence must be one of: ${CONFIDENCES.join(', ')}`);
  }
  if (coerceEnum(f.category, CATEGORIES) === null) {
    errors.push(`category must be one of: ${CATEGORIES.join(', ')}`);
  }

  if (typeof f.title !== 'string' || f.title.length === 0) {
    errors.push('title must be a non-empty string');
  } else if (f.title.length > TITLE_MAX) {
    errors.push(`title must be <= ${TITLE_MAX} chars`);
  }

  if (typeof f.description !== 'string' || f.description.length === 0) {
    errors.push('description must be a non-empty string');
  }

  if (typeof f.evidence !== 'string') {
    errors.push('evidence must be a string');
  }

  if (typeof f.suggestion !== 'string' && f.suggestion !== null) {
    errors.push('suggestion must be a string or null');
  }

  if (typeof f.rule !== 'string' && f.rule !== null) {
    errors.push('rule must be a string or null');
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a finding: case-normalize enums, truncate title, default `rule`
 * to `'llm'`, default missing optional fields, and DROP any non-schema keys.
 *
 * Returns a clean object exposing exactly {@link SCHEMA_KEYS}, or `null` if
 * `validateFinding` fails (after coercion).
 *
 * @param {unknown} finding
 * @returns {Record<string, unknown> | null}
 */
export function normalizeFinding(finding) {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
    return null;
  }
  const f = /** @type {Record<string, unknown>} */ (finding);

  const severity = coerceEnum(f.severity, SEVERITIES);
  const confidence = coerceEnum(f.confidence, CONFIDENCES);
  const category = coerceEnum(f.category, CATEGORIES);

  // Apply title truncation BEFORE validation. The contract is:
  //   - validateFinding flags titles > TITLE_MAX (so callers learn the input
  //     was too long), but
  //   - normalizeFinding is the one that actually truncates to 117 + '...'
  // If we validated the un-truncated title, normalizeFinding could never
  // produce a valid normalized finding from a too-long title. So we truncate
  // first, then validate the truncated form.
  let title = typeof f.title === 'string' ? f.title : '';
  // W7-5: titles are LLM-emitted and attacker-influenceable. In the walkthrough
  // path they render inside <details> blocks, so HTML structural tags
  // (</details>, <details>, <summary>, etc.) would break the collapsible
  // section. Strip them.
  title = title.replace(/<\/?(?:details|summary|table|tr|td|th|thead|tbody|a|img|svg|script|style|iframe)\b[^>]*>/gi, '');
  if (title.length > TITLE_MAX) {
    title = title.slice(0, TITLE_MAX - TITLE_TRUNC_SUFFIX.length) + TITLE_TRUNC_SUFFIX;
  }

  // Apply defaults to optional fields before validating so a finding that
  // simply omitted `evidence`/`suggestion`/`rule` (legitimate) still passes.
  // Required fields (file, line, description, title) are NOT defaulted — a
  // missing required field remains an error.
  const evidence = typeof f.evidence === 'string' ? f.evidence : '';
  const suggestion =
    typeof f.suggestion === 'string' ? f.suggestion : null;
  const rule = typeof f.rule === 'string' ? f.rule : 'llm';

  // Pre-coerce + pre-truncate + pre-defaulted copy for validation: validate
  // the coerced enum values, the truncated title, and the defaulted optionals
  // so `CRITICAL` + long titles + omitted optionals all pass after normalize.
  const coerced = {
    ...f,
    severity,
    confidence,
    category,
    title,
    evidence,
    suggestion,
    rule,
  };

  const { ok } = validateFinding(coerced);
  if (!ok) return null;

  const line = isPositiveInteger(f.line) ? f.line : null;

  const normalized = {
    file: f.file,
    line,
    severity,
    confidence,
    category,
    title,
    description: f.description,
    evidence,
    suggestion,
    rule,
  };
  // Drive output through SCHEMA_KEYS so the shape has a single source of truth
  // and any future schema field additions can't leak extras into the output.
  return Object.fromEntries(SCHEMA_KEYS.map((k) => [k, normalized[k]]));
}

// ---------------------------------------------------------------------------
// parseFindings
// ---------------------------------------------------------------------------

/**
 * Extract a JSON array from raw model output. Tries, in order:
 *   a. The entire trimmed text as JSON.
 *   b. The first fenced ```json (or ```) code block.
 *   c. The substring from the first `[` to the last `]`.
 *
 * Returns the parsed array, or `null` if no strategy yields an array.
 *
 * @param {string} text
 * @returns {unknown[] | null}
 */
function extractJsonArray(text) {
  if (typeof text !== 'string') return null;

  // a. The entire text trimmed as JSON.
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through */
    }
  }

  // b. A fenced ```json (or bare ```) code block.
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) {
    const inner = fence[1].trim();
    try {
      const parsed = JSON.parse(inner);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through */
    }
  }

  // c. First `[` to last `]` (greedy, brace-tolerant).
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    const slice = text.slice(firstBracket, lastBracket + 1);
    try {
      const parsed = JSON.parse(slice);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through */
    }
  }

  return null;
}

/**
 * Build the Set of allowed filenames from `changedFiles`. Each element may be
 * a string OR an object with a `.filename` property (the GitHub PR shape).
 *
 * Returns an empty Set for falsy / non-array inputs.
 *
 * @param {unknown} changedFiles
 * @returns {Set<string>}
 */
function buildAllowedFilesSet(changedFiles) {
  const set = new Set();
  if (!Array.isArray(changedFiles)) return set;
  for (const entry of changedFiles) {
    if (typeof entry === 'string') {
      set.add(entry);
    } else if (entry && typeof entry === 'object') {
      const filename = /** @type {{ filename?: unknown }} */ (entry).filename;
      if (typeof filename === 'string') set.add(filename);
    }
  }
  return set;
}

/**
 * Tolerant parser: extract findings from raw model output.
 *
 * Strategies (JSON array, fenced code block, greedy bracket scan), normalize
 * each element via {@link normalizeFinding}, drop anything that fails the
 * anti-hallucination file filter (file must be in `changedFiles`), and dedup
 * by `${file}:${line ?? 'null'}:${title.toLowerCase()}` (first wins).
 *
 * Never throws. Returns `[]` on any non-parseable input.
 *
 * @param {string} rawModelOutput
 * @param {{ changedFiles?: unknown[] }} [options]
 * @returns {Record<string, unknown>[]}
 */
export function parseFindings(rawModelOutput, options = {}) {
  const allowedFiles = buildAllowedFilesSet(options?.changedFiles);

  const array = extractJsonArray(rawModelOutput);
  if (!array) return [];

  /** @type {Record<string, unknown>[]} */
  const out = [];
  const seen = new Set();

  for (const element of array) {
    const normalized = normalizeFinding(element);
    if (!normalized) continue;

    const file = typeof normalized.file === 'string' ? normalized.file : '';
    if (!allowedFiles.has(file)) continue;

    const line = normalized.line;
    const title = typeof normalized.title === 'string' ? normalized.title : '';
    const key = `${file}:${line === null ? 'null' : line}:${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push(normalized);
  }

  return out;
}

// ---------------------------------------------------------------------------
// parseStructuredReview
// ---------------------------------------------------------------------------

/**
 * Tolerant parser for the v2 structured-review envelope. The model emits a
 * JSON object `{"summary": "...", "findings": [...]}`. This extracts the
 * summary string and delegates the findings array to {@link parseFindings}.
 *
 * Strategies for the envelope (tried in order):
 *   a. The entire trimmed text as JSON (if it starts with `{`).
 *   b. A fenced ```json / ``` code block.
 *   c. The substring from the first `{` to the last `}` (greedy brace scan).
 *
 * If none yield a JSON object, falls back to treating the text as a bare
 * findings array (so `parseFindings` still gets a chance — summary is then
 * the empty string).
 *
 * Never throws. Returns `{summary: '', findings: []}` on any non-parseable
 * input. The summary is coerced to a string; non-string values become `''`.
 *
 * @param {string} rawModelOutput
 * @param {{ changedFiles?: unknown[] }} [options]
 * @returns {{ summary: string, findings: Record<string, unknown>[] }}
 */
export function parseStructuredReview(rawModelOutput, options = {}) {
  const empty = { summary: '', findings: [] };
  if (typeof rawModelOutput !== 'string') return empty;

  const parsed = extractJsonObject(rawModelOutput);

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const summary =
      typeof parsed.summary === 'string' ? parsed.summary : '';
    const findingsRaw = Array.isArray(parsed.findings) ? parsed.findings : [];
    const findings = parseFindings(JSON.stringify(findingsRaw), options);
    return { summary, findings };
  }

  // Fall back: maybe the model emitted a bare findings array.
  const findings = parseFindings(rawModelOutput, options);
  return { summary: '', findings };
}

/**
 * Extract a JSON OBJECT from raw model output. Mirrors {@link extractJsonArray}
 * but requires the result to be a plain object (not an array).
 *
 * @param {string} text
 * @returns {Record<string, unknown> | null}
 */
function extractJsonObject(text) {
  if (typeof text !== 'string') return null;

  // a. The entire text trimmed as JSON.
  const trimmed = text.trim();
  // If the text is a bare JSON array, it's not an object envelope — bail so
  // the caller can delegate to parseFindings (bare-array fallback).
  if (trimmed.startsWith('[')) return null;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return /** @type {Record<string, unknown>} */ (parsed);
      }
    } catch {
      /* fall through */
    }
  }

  // b. A fenced ```json (or bare ```) code block.
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) {
    const inner = fence[1].trim();
    // A fenced bare array is not an object envelope.
    if (inner.startsWith('[')) {
      /* fall through to brace scan, but guard below */
    } else {
      try {
        const parsed = JSON.parse(inner);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return /** @type {Record<string, unknown>} */ (parsed);
        }
      } catch {
        /* fall through */
      }
    }
  }

  // c. First `{` to last `}` (greedy).
  // Skip when the text is clearly a bare array — the brace scan would
  // otherwise mistake an array element's `{...}` for the envelope.
  const firstBracket = text.indexOf('[');
  const firstBrace = text.indexOf('{');
  if (
    firstBrace !== -1 &&
    !(firstBracket !== -1 && firstBracket < firstBrace)
  ) {
    const lastBrace = text.lastIndexOf('}');
    if (lastBrace !== -1 && lastBrace > firstBrace) {
      const slice = text.slice(firstBrace, lastBrace + 1);
      try {
        const parsed = JSON.parse(slice);
        if (
          parsed &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed)
        ) {
          return /** @type {Record<string, unknown>} */ (parsed);
        }
      } catch {
        /* fall through */
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// rankAndCapFindings
// ---------------------------------------------------------------------------

/**
 * A safe comparator lookup for severity/confidence ranks. Unknown values sort
 * last.
 *
 * @param {string} value
 * @param {Record<string, number>} rankMap
 * @returns {number}
 */
function rankOf(value, rankMap) {
  if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(rankMap, value)) {
    return rankMap[value];
  }
  return Number.MAX_SAFE_INTEGER;
}

/**
 * Comparator: severity ASC, confidence ASC, file ASC, line ASC (null sorts last).
 *
 * @param {Record<string, unknown>} a
 * @param {Record<string, unknown>} b
 * @returns {number}
 */
function findingComparator(a, b) {
  const sevA = rankOf(/** @type {string} */ (a.severity), SEVERITY_RANK);
  const sevB = rankOf(/** @type {string} */ (b.severity), SEVERITY_RANK);
  if (sevA !== sevB) return sevA - sevB;

  const confA = rankOf(/** @type {string} */ (a.confidence), CONFIDENCE_RANK);
  const confB = rankOf(/** @type {string} */ (b.confidence), CONFIDENCE_RANK);
  if (confA !== confB) return confA - confB;

  const fileA = typeof a.file === 'string' ? a.file : '';
  const fileB = typeof b.file === 'string' ? b.file : '';
  if (fileA < fileB) return -1;
  if (fileA > fileB) return 1;

  const lineA = a.line;
  const lineB = b.line;
  // null sorts AFTER any number.
  if (lineA === null && lineB !== null) return 1;
  if (lineA !== null && lineB === null) return -1;
  if (typeof lineA === 'number' && typeof lineB === 'number') {
    if (lineA !== lineB) return lineA - lineB;
  }
  return 0;
}

/**
 * Filter, sort, and cap findings.
 *
 * Drops findings whose severity rank is GREATER than `SEVERITY_RANK[minSeverity]`,
 * sorts by (severity, confidence, file, line), and caps at `maxFindings`.
 *
 * @param {Record<string, unknown>[]} findings
 * @param {{ maxFindings?: number, minSeverity?: string }} [options]
 * @returns {Record<string, unknown>[]}
 */
export function rankAndCapFindings(findings, options = {}) {
  if (!Array.isArray(findings)) return [];

  const maxFindings =
    typeof options.maxFindings === 'number' && options.maxFindings >= 0
      ? Math.floor(options.maxFindings)
      : 8;
  const minSeverity =
    typeof options.minSeverity === 'string' && Object.prototype.hasOwnProperty.call(SEVERITY_RANK, options.minSeverity)
      ? options.minSeverity
      : 'info';
  const minRank = SEVERITY_RANK[minSeverity];

  const filtered = findings.filter((f) => {
    const sev = typeof f.severity === 'string' ? f.severity : '';
    const rank = rankOf(sev, SEVERITY_RANK);
    return rank <= minRank;
  });

  // Copy before sort so we never mutate caller input.
  const sorted = [...filtered].sort(findingComparator);

  return sorted.slice(0, maxFindings);
}

// ---------------------------------------------------------------------------
// mergeFindings
// ---------------------------------------------------------------------------

/**
 * Build the location key used by {@link mergeFindings}.
 *
 * @param {Record<string, unknown>} f
 * @returns {string}
 */
function locationKey(f) {
  const file = typeof f.file === 'string' ? f.file : '';
  const line = f.line === null || f.line === undefined ? 'null' : f.line;
  return `${file}:${line}`;
}

/**
 * Merge LLM-emitted and deterministic-scanner findings.
 *
 * At each `file:line` key, a deterministic finding supersedes an LLM finding
 * with the SAME title (case-insensitive). If titles differ, both are kept
 * (rare: same location, distinct issues). No sort/cap here — the caller does
 * that via {@link rankAndCapFindings}.
 *
 * @param {Record<string, unknown>[]} llmFindings
 * @param {Record<string, unknown>[]} deterministicFindings
 * @returns {Record<string, unknown>[]}
 */
export function mergeFindings(llmFindings, deterministicFindings) {
  const llm = Array.isArray(llmFindings) ? llmFindings : [];
  const det = Array.isArray(deterministicFindings) ? deterministicFindings : [];

  /** @type {Map<string, Record<string, unknown>[]>} */
  const buckets = new Map();
  const put = (f, source) => {
    const key = locationKey(f);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ finding: f, source });
  };

  for (const f of llm) put(f, 'llm');
  for (const f of det) put(f, 'det');

  /** @type {Record<string, unknown>[]} */
  const merged = [];
  for (const entries of buckets.values()) {
    const hasDet = entries.some((e) => e.source === 'det');
    if (!hasDet) {
      // Pure-LLM bucket: keep everything (dedup is the parser's job).
      for (const e of entries) merged.push(e.finding);
      continue;
    }
    const detEntries = entries.filter((e) => e.source === 'det');
    const llmEntries = entries.filter((e) => e.source === 'llm');

    // Lower-cased title set of deterministic findings.
    const detTitles = new Set(
      detEntries
        .map((e) => (typeof e.finding.title === 'string' ? e.finding.title.toLowerCase() : ''))
        .filter((t) => t.length > 0),
    );

    // Deterministic entries always win.
    for (const e of detEntries) merged.push(e.finding);
    // LLM entries survive only if their title isn't covered by a deterministic one.
    for (const e of llmEntries) {
      const titleLC =
        typeof e.finding.title === 'string' ? e.finding.title.toLowerCase() : '';
      if (titleLC.length > 0 && detTitles.has(titleLC)) continue;
      merged.push(e.finding);
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// formatFindingsAsSummary
// ---------------------------------------------------------------------------

/**
 * Render findings as a markdown summary comment body.
 *
 * Structure (see contract):
 *   ## <reviewerName>
 *
 *   <if metadata.deterministicFindingsCount > 0>: 🔍 Scanners found N ...
 *   <if metadata.truncated > 0>: truncated note
 *
 *   ### Summary
 *   <count> findings: 🔴 N critical · 🟠 N high · ...
 *
 *   <for each severity group with count > 0, in severity order>:
 *   #### <emoji> <Severity> (<count>)
 *   - **<file>**<if line>:L<line><endif> — <title>
 *     <description>
 *     <if suggestion> 💡 <suggestion><endif>
 *     <if evidence> > `<evidence>`<endif>
 *
 *   <if findings empty>:
 *   No issues found. The changes look good. ✅
 *
 *   <!-- zai-code-review -->  (byte-exact idempotency marker)
 *
 * @param {Record<string, unknown>[]} findings
 * @param {{ reviewerName?: string, metadata?: Record<string, unknown> }} [options]
 * @returns {string}
 */
export function formatFindingsAsSummary(findings, options = {}) {
  const reviewerName =
    typeof options.reviewerName === 'string' && options.reviewerName.length > 0
      ? options.reviewerName
      : 'Z.ai Code Review';
  const metadata =
    options.metadata && typeof options.metadata === 'object' ? options.metadata : {};

  const list = Array.isArray(findings) ? findings : [];

  // Count per severity.
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of list) {
    const sev = typeof f.severity === 'string' ? f.severity : '';
    if (Object.prototype.hasOwnProperty.call(counts, sev)) {
      counts[sev] += 1;
    }
  }
  const total = list.length;

  // Header.
  const lines = [];
  lines.push(`## ${reviewerName}`);
  lines.push('');

  // Optional deterministic-findings line.
  const detCount = typeof metadata.deterministicFindingsCount === 'number' ? metadata.deterministicFindingsCount : 0;
  if (detCount > 0) {
    lines.push(`🔍 Scanners found ${detCount} deterministic issues.`);
    lines.push('');
  }

  // Optional truncation note.
  const truncated = typeof metadata.truncated === 'number' ? metadata.truncated : 0;
  if (truncated > 0) {
    lines.push(`_${truncated} findings truncated to cap._`);
    lines.push('');
  }

  // Phase 8.1: optional pre-rendered "Suggested reviewers" line (CODEOWNERS).
  const suggestedReviewersLine =
    typeof metadata.suggestedReviewersLine === 'string' ? metadata.suggestedReviewersLine : '';
  if (suggestedReviewersLine.length > 0) {
    lines.push(suggestedReviewersLine);
    lines.push('');
  }

  // Summary section.
  lines.push('### Summary');
  lines.push('');
  lines.push(
    `${total} findings: 🔴 ${counts.critical} critical · 🟠 ${counts.high} high · 🟡 ${counts.medium} medium · 🔵 ${counts.low} low · ➖ ${counts.info} info`,
  );
  lines.push('');

  if (total === 0) {
    lines.push('No issues found. The changes look good. ✅');
    lines.push('');
  } else {
    // Group by severity in SEVERITIES order.
    for (const sev of SEVERITIES) {
      if (counts[sev] === 0) continue;
      const inGroup = list.filter((f) => f.severity === sev);
      lines.push(`#### ${SEVERITY_EMOJI[sev]} ${SEVERITY_LABEL[sev]} (${counts[sev]})`);
      lines.push('');
      for (const f of inGroup) {
        const file = typeof f.file === 'string' ? f.file : '';
        const line = f.line;
        const title = typeof f.title === 'string' ? f.title : '';
        const description = typeof f.description === 'string' ? f.description : '';
        const evidence = typeof f.evidence === 'string' ? f.evidence : '';
        const suggestion =
          typeof f.suggestion === 'string' && f.suggestion.length > 0 ? f.suggestion : null;

        const locSuffix = typeof line === 'number' && line > 0 ? `:L${line}` : '';
        // W2-SEC-6: filenames are attacker-controlled and were rendered raw as
        // markdown. A filename containing markdown metacharacters (e.g.
        // weird**name.js) would inject formatting (bold) into the summary.
        // Render the filename as inline code (backticks) which neutralizes
        // all markdown special characters. The line suffix is appended OUTSIDE
        // the code span so the :L42 anchor link is still parsed by GitHub.
        // W8-1: replace backticks in the filename (escapes don't work in code spans).
        const safeFile = String(file).replace(/`/g, "'");
        lines.push(`- \`${safeFile}\`${locSuffix} — ${title}`);
        if (description.length > 0) {
          lines.push(`  ${description}`);
        }
        if (suggestion !== null) {
          lines.push(`  💡 ${suggestion}`);
        }
        if (evidence.length > 0) {
          lines.push(`  > \`${String(evidence).replace(/`/g, "'")}\``);
        }
      }
      lines.push('');
    }
  }

  // Trailing idempotency marker — byte-exact, required by comments.js.
  lines.push(MARKER);

  // Each line is followed by '\n' via join. The marker line is last.
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Phase 6.3 — incremental review (findings dedup across runs)
// ---------------------------------------------------------------------------
//
// On re-push the bot re-reviews and may re-post the same findings that were
// already reported (and possibly resolved) on a prior run. To avoid the noise
// of "the same findings re-appearing every push", we store a content hash of
// each finding inside a hidden HTML comment appended to the review body. On
// the next run we parse that block out of the prior review and suppress any
// finding whose hash is unchanged — CodeRabbit's `auto_incremental_review`
// pattern. The hash block is a SEPARATE HTML comment from {@link MARKER} so
// the existing marker-based idempotency detection in `listBotReviews`
// (which searches for `<!-- zai-code-review -->`) keeps working unchanged.

/**
 * The literal prefix/suffix of the hidden HTML comment that carries the
 * findings hashes. Kept byte-exact — {@link parseFindingsHashBlock} matches
 * this prefix. MUST be a distinct comment from {@link MARKER} so the marker
 * scan and the hash scan don't collide.
 */
const HASH_BLOCK_PREFIX = '<!-- zai-hashes:';
const HASH_BLOCK_SUFFIX = ' -->';

/**
 * Compute a stable content hash for a finding.
 *
 * The hash is SHA-256 (hex) of the canonical key
 * `${file}:${line ?? 'null'}:${severity}:${title}:${description}`. Only those
 * five fields participate by default — `evidence`, `suggestion`, `rule`,
 * `confidence`, and `category` are intentionally excluded so a re-review that
 * only changed the suggestion text does NOT re-surface the finding as "new"
 * (the location and the issue identity are unchanged).
 *
 * SCN-3 / W2-5: for findings produced by deterministic scanners (rule starts
 * with `regex:`, `gitleaks:`, `secret:`, or `astgrep:`), `evidence` is ALSO
 * included in the hash. A rotated secret (or a different offending line for an
 * astgrep rule like eval/sql-concat) has a different evidence value and must
 * hash differently so the new occurrence is re-surfaced instead of being
 * suppressed as "unchanged".
 *
 * Defensive: missing/non-string fields are coerced to '' (or 'null' for line)
 * so a malformed finding never throws — it just hashes to a stable value.
 *
 * @param {Record<string, unknown>} finding
 * @returns {string} 64-char lowercase hex SHA-256 digest.
 */
export function hashFinding(finding) {
  const f = finding && typeof finding === 'object' ? finding : {};
  const file = typeof f.file === 'string' ? f.file : '';
  const line =
    typeof f.line === 'number' && Number.isFinite(f.line) ? f.line : 'null';
  const severity = typeof f.severity === 'string' ? f.severity : '';
  const title = typeof f.title === 'string' ? f.title : '';
  const description = typeof f.description === 'string' ? f.description : '';
  let key = `${file}:${line}:${severity}:${title}:${description}`;
  // SCN-3 / W2-5: include evidence for findings produced by deterministic
  // scanners so a different match (rotated secret, different offending line)
  // hashes differently and is re-surfaced instead of suppressed as
  // "unchanged". This covers regex:/gitleaks:/secret: (secret scanners) and
  // astgrep: (deterministic pattern rules like eval, sql-concat). LLM
  // findings (no rule or rule: 'llm') keep evidence excluded for stability.
  if (
    f.rule &&
    typeof f.rule === 'string' &&
    /^(regex|gitleaks|secret|astgrep):/i.test(f.rule)
  ) {
    key += ':' + (typeof f.evidence === 'string' ? f.evidence : '');
  }
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/**
 * Render the hidden HTML comment block carrying the hashes of every finding.
 *
 * Output: `<!-- zai-hashes:h1,h2,h3 -->` (comma-joined, no spaces). Empty
 * input produces `<!-- zai-hashes: -->` (empty list — still a valid block so
 * the next run can parse it and get an empty Set).
 *
 * The block is appended to the review body (separately from {@link MARKER}).
 * Dedups repeated hashes so a finding reported twice in the same run only
 * appears once in the canonical set.
 *
 * @param {Record<string, unknown>[]} findings
 * @returns {string}
 */
export function buildFindingsHashBlock(findings) {
  const list = Array.isArray(findings) ? findings : [];
  const seen = new Set();
  for (const f of list) {
    seen.add(hashFinding(f));
  }
  return `${HASH_BLOCK_PREFIX}${[...seen].join(',')}${HASH_BLOCK_SUFFIX}`;
}

/**
 * Extract the findings hashes from a prior review body.
 *
 * Matches the FIRST `<!-- zai-hashes:... -->` comment (oldest wins when a body
 * somehow carries more than one — the canonical block is the one the bot
 * itself posts; a malicious/legacy body with two blocks is read
 * conservatively). Returns the hashes as a Set of strings.
 *
 * Defensive: returns an empty Set for non-string input, missing block, or an
 * empty list inside the block. Never throws.
 *
 * @param {string} reviewBody
 * @returns {Set<string>}
 */
export function parseFindingsHashBlock(reviewBody) {
  const out = new Set();
  if (typeof reviewBody !== 'string') return out;
  const match = reviewBody.match(/<!-- zai-hashes:(.*?) -->/);
  if (!match) return out;
  const inner = match[1];
  if (typeof inner !== 'string' || inner.length === 0) return out;
  for (const piece of inner.split(',')) {
    const trimmed = piece.trim();
    if (trimmed.length > 0) out.add(trimmed);
  }
  return out;
}

/**
 * Drop findings whose hash is in `priorHashes` — the incremental filter.
 *
 * Used by the PR review path so a re-push only surfaces findings that are NEW
 * or CHANGED since the last bot review (matching CodeRabbit's
 * `auto_incremental_review` behavior). `priorHashes` is the Set returned by
 * {@link parseFindingsHashBlock} against the prior review body.
 *
 * Defensive: a non-Set `priorHashes` (null/undefined) is treated as empty —
 * i.e. "first run" semantics (everything is kept). A non-array `newFindings`
 * yields `{ kept: [], suppressed: 0 }`.
 *
 * @param {Record<string, unknown>[]} newFindings
 * @param {Set<string>} priorHashes
 * @returns {{ kept: Record<string, unknown>[], suppressed: number }}
 */
export function filterIncrementalFindings(newFindings, priorHashes) {
  const list = Array.isArray(newFindings) ? newFindings : [];
  const known =
    priorHashes instanceof Set ? priorHashes : new Set();
  /** @type {Record<string, unknown>[]} */
  const kept = [];
  let suppressed = 0;
  for (const f of list) {
    if (known.has(hashFinding(f))) {
      suppressed += 1;
    } else {
      kept.push(f);
    }
  }
  return { kept, suppressed };
}

// Exported internals for testing (none beyond the public exports today).
