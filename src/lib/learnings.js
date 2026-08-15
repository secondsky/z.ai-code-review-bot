/**
 * `.zai/learnings.yml` — previously-reviewed / won't-fix memory.
 *
 * A `.zai/learnings.yml` committed in the repo records "this pattern is
 * acceptable here" / "this was resolved as won't-fix" so the bot doesn't
 * re-raise the SAME finding on every run (a common annoyance with deterministic
 * review bots). The file lives in the repository, so it is ATTACKER-CONTROLLABLE
 * in fork PRs: this module treats it as UNTRUSTED throughout.
 *
 *   - The parser is hand-rolled (no js-yaml dependency to attack the surface),
 *     tolerant of malformed input, and never throws.
 *   - `validateLearning` coerces types and DROPS every entry missing a string
 *     `file` or string `pattern`; `reason` is optional but, when present, must
 *     be a string.
 *   - `loadLearnings` wraps fetch + decode + parse in a single NEVER-throw
 *     boundary: any failure (404, parse error, oversized, missing SHA) → `[]`
 *     + a `core.warning`. The feature is OPT-IN (ZAI_LEARNINGS_ENABLED) because
 *     it is a new trust surface.
 *   - `matchesLearning` is conservative: the pattern must appear (case-
 *     insensitively) as a substring of `finding.title` OR `finding.description`,
 *     AND the finding's file must match the learning's glob. Only a CLEAR match
 *     suppresses — partial/garbled patterns never suppress.
 *
 * Re the YAML parser: `parseZaiYml` in `./repo-config.js` recognizes only the
 * `reviews` and `scanners` top-level keys, so it would silently drop a
 * `learnings:` key. Rather than widen that shared parser's surface (and risk a
 * regression for repo-config), this module ships a tiny subset parser that only
 * understands the learnings shape. It reuses the same comment-strip + unquote
 * idioms so the dialect matches `.zai.yml`.
 *
 * No `@actions/core` import; `core` is injected via `deps`.
 *
 * @module src/lib/learnings.js
 */

import { matchesAnyPattern } from './glob.js';

/** Hard cap on the size of a `.zai/learnings.yml` we will parse (cost/DoS guard). */
const MAX_LEARNINGS_BYTES = 64 * 1024; // 64 KiB

/** Maximum number of learning entries we keep (defense against a huge list). */
const MAX_LEARNINGS_ENTRIES = 500;

/** Maximum length of any single `file` / `pattern` / `reason` string. */
const MAX_FIELD_CHARS = 1000;

/* ------------------------------------------------------------------ *
 * Minimal YAML subset parser (learnings-only)
 * ------------------------------------------------------------------ */

/**
 * Strip a YAML `# ...` comment from a line, UNLESS the `#` is inside a
 * single- or double-quoted string. Mirrors `stripComment` in repo-config.js so
 * the dialect matches.
 *
 * @param {string} line
 * @returns {string}
 */
function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) {
      // W8-4: only treat `'` as a quote toggle when NOT embedded in a word.
      // An apostrophe glued to a letter/digit (like in `don't` or `it's`)
      // is not a delimiter; treating it as one flips inSingle permanently and
      // disables comment stripping for the rest of the line. Mirrors the guard
      // in repo-config.js stripComment.
      // W12-4b: the guard must NOT apply when already inside a single-quoted
      // string — a `'` inside is always the closing delimiter.
      if (inSingle) {
        inSingle = false;
      } else {
        const prev = i > 0 ? line[i - 1] : '';
        if (!/[A-Za-z0-9]/.test(prev)) {
          inSingle = !inSingle;
        }
      }
    } else if (ch === '"' && !inSingle) {
      // W15-A6-6: mirror the W8-4 apostrophe guard for `"` — a double quote
      // glued to a word character (like the inches mark in `5" floppy`) is
      // not a delimiter; treating it as one flips inDouble permanently and
      // disables comment stripping for the rest of the line (the trailing
      // `# comment` then survives into the parsed value). As with W8-4, the
      // guard must NOT apply when already inside a double-quoted string — a
      // `"` inside is always the closing delimiter (values legitimately end
      // in word characters, e.g. `"x # not comment"`).
      if (inDouble) {
        inDouble = false;
      } else {
        const prev = i > 0 ? line[i - 1] : '';
        if (!/[A-Za-z0-9]/.test(prev)) {
          inDouble = !inDouble;
        }
      }
    } else if (ch === '#' && !inSingle && !inDouble) {
      const prev = i > 0 ? line[i - 1] : '';
      if (i === 0 || /\s/.test(prev)) {
        return line.slice(0, i);
      }
    }
  }
  return line;
}

/**
 * Unquote a YAML scalar value: strips matching surrounding single or double
 * quotes. Returns the input unchanged when not quoted.
 *
 * @param {string} v
 * @returns {string}
 */
function unquote(v) {
  if (typeof v !== 'string' || v.length < 2) return v;
  if (
    (v[0] === '"' && v[v.length - 1] === '"') ||
    (v[0] === "'" && v[v.length - 1] === "'")
  ) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Parse a minimal YAML subset into `{ learnings: Array<{file, pattern, reason?}> }`.
 *
 * Supports exactly the structure of `.zai/learnings.yml`:
 *   - a top-level `learnings:` key
 *   - arrays of objects (`- key: value` on consecutive lines, 2-space indented)
 *   - quoted or unquoted scalar values
 *   - `#` comments (line and inline, quote-aware)
 *
 * Unknown top-level keys are skipped. Malformed input never throws: the
 * offending line is skipped and parsing continues. The result is the parsed
 * (but NOT yet validated) array; {@link parseLearnings} runs validation.
 *
 * Pure (exported for testing).
 *
 * @param {string} text
 * @returns {Array<Record<string, string>>}
 */
function parseLearningsYml(text) {
  /** @type {Array<Record<string, string>>} */
  const entries = [];
  if (typeof text !== 'string' || text.length === 0) return entries;

  // W15-A6-5: strip a leading UTF-8 BOM. Editors that write a BOM made the
  // first line "\uFEFFlearnings:", which failed the top-level key match, so
  // every entry was silently skipped (the feature disabled itself).
  const src = text.replace(/^\uFEFF/, '');
  const lines = src.split(/\r?\n/);
  let inLearnings = false;
  /** @type {Record<string, string> | null} */
  let pending = null;

  const flush = () => {
    if (pending !== null) {
      entries.push(pending);
      pending = null;
    }
  };

  for (const raw of lines) {
    const lineNoComment = stripComment(raw);
    const line = lineNoComment.replace(/\s+$/, '');
    const indent = line.length - line.replace(/^\s+/, '').length;
    const trimmed = line.trim();
    if (trimmed === '') continue;

    // Top-level key (indent 0).
    if (indent === 0) {
      flush();
      const m = trimmed.match(/^([A-Za-z0-9_]+):\s*$/);
      if (!m) {
        inLearnings = false;
        continue;
      }
      inLearnings = m[1] === 'learnings';
      continue;
    }

    if (!inLearnings) continue; // indented line outside learnings — skip

    // Array item: a line beginning with `- `.
    if (/^-\s+/.test(trimmed) || trimmed === '-') {
      flush();
      const body = trimmed.replace(/^-\s+/, '');
      // First field of a new object: `- key: value` (or bare `- `).
      const km = body.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
      if (km) {
        pending = { [km[1]]: unquote(km[2]).trim() };
      } else {
        pending = {};
      }
      continue;
    }

    // Continuation key inside the current object: `  key: value` at indent >= 2.
    const km = trimmed.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (km && pending !== null) {
      pending[km[1]] = unquote(km[2]).trim();
      continue;
    }
    // Otherwise: stray indented line — ignore.
  }
  flush();
  return entries;
}

/* ------------------------------------------------------------------ *
 * parseLearnings
 * ------------------------------------------------------------------ */

/**
 * Clamp a string field to {@link MAX_FIELD_CHARS}; returns the input unchanged
 * for non-strings.
 *
 * @param {unknown} v
 * @returns {string}
 */
function clampField(v) {
  if (typeof v !== 'string') return '';
  return v.length > MAX_FIELD_CHARS ? v.slice(0, MAX_FIELD_CHARS) : v;
}

/**
 * Validate one parsed entry: keep only string `file` + string `pattern`, plus an
 * optional string `reason`. Drop unknown keys. Returns `null` when the entry is
 * missing a required field.
 *
 * @param {unknown} entry
 * @returns {{file: string, pattern: string, reason?: string} | null}
 */
function validateLearning(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const e = /** @type {Record<string, unknown>} */ (entry);
  const file = clampField(e.file);
  const pattern = clampField(e.pattern);
  if (typeof file !== 'string' || file.trim() === '') return null;
  if (typeof pattern !== 'string' || pattern.trim() === '') return null;
  const out = { file, pattern };
  const reason = clampField(e.reason);
  if (typeof reason === 'string' && reason.trim() !== '') {
    out.reason = reason;
  }
  return out;
}

/**
 * Parse a `.zai/learnings.yml` document into a validated array of learnings.
 *
 * Each entry is normalized to `{file, pattern, reason?}`:
 *   - `file` (required, non-empty string) — a glob matched against finding paths.
 *   - `pattern` (required, non-empty string) — a case-insensitive substring
 *     matched against `finding.title` OR `finding.description`.
 *   - `reason` (optional string) — human context, never used for matching.
 *
 * Invalid entries are dropped. The parser never throws. Empty / missing
 * `learnings:` key yields `[]`.
 *
 * Pure (exported for testing).
 *
 * @param {string} text
 * @returns {Array<{file: string, pattern: string, reason?: string}>}
 */
export function parseLearnings(text) {
  const parsed = parseLearningsYml(text);
  /** @type {Array<{file: string, pattern: string, reason?: string}>} */
  const out = [];
  for (const entry of parsed) {
    const validated = validateLearning(entry);
    if (validated === null) continue;
    out.push(validated);
    if (out.length >= MAX_LEARNINGS_ENTRIES) break;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * matchesLearning
 * ------------------------------------------------------------------ */

/**
 * Check if a finding matches a learning (i.e. should be suppressed).
 *
 * Match logic (conservative — only a CLEAR match suppresses):
 *   1. `learning.file` is a glob; `finding.file` must match it (full path OR
 *      basename — same semantics as `matchesAnyPattern` in glob.js).
 *   2. `learning.pattern` is a case-insensitive substring of `finding.title`
 *      OR `finding.description`.
 *
 * Non-string / missing fields never match. Never throws.
 *
 * @param {{file?: string, title?: string, description?: string}} finding
 * @param {{file?: string, pattern?: string}} learning
 * @returns {boolean}
 */
export function matchesLearning(finding, learning) {
  if (!finding || typeof finding !== 'object') return false;
  if (!learning || typeof learning !== 'object') return false;
  const fFile = typeof finding.file === 'string' ? finding.file : '';
  const lFile = typeof learning.file === 'string' ? learning.file : '';
  const lPattern = typeof learning.pattern === 'string' ? learning.pattern : '';
  if (fFile === '' || lFile === '' || lPattern === '') return false;

  // Glob match on the file.
  if (!matchesAnyPattern(fFile, [lFile])) return false;

  // Case-insensitive substring match on title OR description.
  const needle = lPattern.toLowerCase();
  const title = typeof finding.title === 'string' ? finding.title.toLowerCase() : '';
  const description =
    typeof finding.description === 'string' ? finding.description.toLowerCase() : '';
  return title.includes(needle) || description.includes(needle);
}

/* ------------------------------------------------------------------ *
 * filterFindingsByLearnings
 * ------------------------------------------------------------------ */

/**
 * Filter out findings that match ANY learning.
 *
 * A finding is suppressed when at least one learning matches it via
 * {@link matchesLearning}. Findings with no matching learning are kept.
 * Non-array inputs yield `{ kept: [], suppressed: 0 }`. An empty / non-array
 * learnings list keeps everything (the common case: no learnings file).
 *
 * The result preserves the input order of `findings`.
 *
 * @param {Array} findings
 * @param {Array} learnings
 * @returns {{ kept: Array, suppressed: number }}
 */
export function filterFindingsByLearnings(findings, learnings) {
  const list = Array.isArray(findings) ? findings : [];
  const rules = Array.isArray(learnings) ? learnings : [];
  if (rules.length === 0) {
    return { kept: [...list], suppressed: 0 };
  }
  /** @type {unknown[]} */
  const kept = [];
  let suppressed = 0;
  for (const f of list) {
    let isMatch = false;
    for (const learning of rules) {
      if (matchesLearning(f, learning)) {
        isMatch = true;
        break;
      }
    }
    if (isMatch) {
      suppressed += 1;
    } else {
      kept.push(f);
    }
  }
  return { kept, suppressed };
}

/* ------------------------------------------------------------------ *
 * formatLearningsForPrompt
 * ------------------------------------------------------------------ */

/**
 * Format learnings as prompt context so the model knows which patterns were
 * previously accepted and should NOT be re-flagged.
 *
 * Renders nothing for an empty / non-array learnings list (so an opt-in repo
 * with no file pays no prompt cost). Otherwise:
 *
 *   The following patterns have been previously reviewed and accepted — do not flag them:
 *   - <file>: <pattern>
 *   - ...
 *
 * The caller wraps this string in `<untrusted_input>` before injection (the
 * learnings file is attacker-controllable in fork PRs).
 *
 * @param {Array<{file?: string, pattern?: string}>} learnings
 * @returns {string}
 */
export function formatLearningsForPrompt(learnings) {
  const list = Array.isArray(learnings) ? learnings : [];
  if (list.length === 0) return '';
  const lines = [
    'The following patterns have been previously reviewed and accepted — do not flag them:',
  ];
  for (const l of list) {
    const file = typeof l?.file === 'string' ? l.file : '';
    const pattern = typeof l?.pattern === 'string' ? l.pattern : '';
    if (file === '' || pattern === '') continue;
    lines.push(`- ${file}: ${pattern}`);
  }
  // If every entry was malformed, fall back to the empty string.
  if (lines.length === 1) return '';
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * loadLearnings
 * ------------------------------------------------------------------ */

/**
 * Resolve the PR head SHA from `opts.headSha` or
 * `context.payload.pull_request.head.sha`.
 *
 * @param {Object} opts
 * @returns {string}
 */
function resolveHeadSha(opts) {
  if (typeof opts.headSha === 'string' && opts.headSha !== '') return opts.headSha;
  const sha = opts.context?.payload?.pull_request?.head?.sha;
  return typeof sha === 'string' ? sha : '';
}

/**
 * Load `.zai/learnings.yml` from the PR's head SHA. Treated as UNTRUSTED.
 *
 * Flow:
 *   1. Resolve the head SHA (from `opts.headSha` or the PR payload).
 *   2. Fetch the file via `octokit.rest.repos.getContent({owner, repo, path, ref})`.
 *   3. Base64-decode the content.
 *   4. Parse with {@link parseLearnings} (validates + drops bad entries).
 *
 * On ANY error (404, parse failure, oversized, missing SHA, missing owner/repo),
 * `deps.core.warning(...)` is called and `[]` is returned. This function NEVER
 * throws — a broken/untrusted `.zai/learnings.yml` must never break the review.
 *
 * @param {Object} opts - `{ octokit, context, path?, headSha? }`
 * @param {Object} [deps] - `{ core }` (for warnings).
 * @param {{warning?: Function, info?: Function}} [deps.core]
 * @returns {Promise<Array<{file: string, pattern: string, reason?: string}>>}
 */
export async function loadLearnings(opts = {}, deps = {}) {
  const { octokit, context } = opts;
  const path =
    typeof opts.path === 'string' && opts.path !== ''
      ? opts.path
      : '.zai/learnings.yml';
  const core = deps.core;
  const warn = (msg) => {
    if (core && typeof core.warning === 'function') core.warning(msg);
  };

  const owner = context?.repo?.owner;
  const repo = context?.repo?.repo;
  if (!owner || !repo) {
    warn('learnings: missing owner/repo in context; skipping .zai/learnings.yml load.');
    return [];
  }

  const headSha = resolveHeadSha(opts);
  if (headSha === '') {
    warn('learnings: could not resolve PR head SHA; skipping .zai/learnings.yml load.');
    return [];
  }

  let data;
  try {
    const resp = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref: headSha,
    });
    data = resp?.data;
  } catch (error) {
    const status = error?.status;
    if (status === 404) {
      // 404 is the common case (most repos don't have a learnings file); still
      // surface a warning so operators can observe it.
      warn(`learnings: no ${path} found at ${headSha.slice(0, 7)} (404).`);
      return [];
    }
    warn(
      `learnings: failed to fetch ${path} (${status ?? 'unknown'}): ` +
        `${error?.message ?? String(error)}`,
    );
    return [];
  }

  // Decode the base64 content. GitHub returns `{content, encoding}` for files;
  // a directory or a non-file response is treated as "no learnings".
  let text;
  if (data && typeof data.content === 'string') {
    const size = typeof data.size === 'number' ? data.size : data.content.length;
    if (size > MAX_LEARNINGS_BYTES) {
      warn(
        `learnings: ${path} is ${size} bytes (cap ${MAX_LEARNINGS_BYTES}); skipping.`,
      );
      return [];
    }
    try {
      text = Buffer.from(data.content.replace(/\s/g, ''), 'base64').toString('utf8');
    } catch {
      warn(`learnings: ${path} could not be base64-decoded; skipping.`);
      return [];
    }
    if (typeof text === 'string' && text.length > MAX_LEARNINGS_BYTES) {
      warn(
        `learnings: ${path} decodes to ${text.length} chars (cap ${MAX_LEARNINGS_BYTES}); skipping.`,
      );
      return [];
    }
  } else if (typeof data === 'string') {
    text = data;
    if (text.length > MAX_LEARNINGS_BYTES) {
      warn(
        `learnings: ${path} is ${text.length} chars (cap ${MAX_LEARNINGS_BYTES}); skipping.`,
      );
      return [];
    }
  } else {
    // Not a file (directory listing or symlink) — no learnings.
    return [];
  }

  let parsed;
  try {
    parsed = parseLearnings(text);
  } catch (error) {
    // parseLearnings is never expected to throw, but defend in depth.
    warn(
      `learnings: ${path} failed to parse: ${error?.message ?? String(error)}`,
    );
    return [];
  }

  if (parsed.length === 0) {
    warn(
      `learnings: ${path} parsed but contained no valid entries; ignoring.`,
    );
    return [];
  }
  return parsed;
}
