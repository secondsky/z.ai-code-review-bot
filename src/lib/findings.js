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
  const lower = value.toLowerCase();
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
        lines.push(`- **${file}**${locSuffix} — ${title}`);
        if (description.length > 0) {
          lines.push(`  ${description}`);
        }
        if (suggestion !== null) {
          lines.push(`  💡 ${suggestion}`);
        }
        if (evidence.length > 0) {
          lines.push(`  > \`${evidence}\``);
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

// Exported internals for testing (none beyond the public exports today).
