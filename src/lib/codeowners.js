/**
 * CODEOWNERS-aware reviewer suggestions (Phase 8.1).
 *
 * Parses the repo's CODEOWNERS file and suggests reviewers for the PR's changed
 * paths. The suggestion is read-only by default (a line in the review summary);
 * opt-in auto-assignment calls `pulls.requestReviewers`.
 *
 * The CODEOWNERS file is fetched from the PR's HEAD SHA and is treated as
 * UNTRUSTED attacker-controllable input: in a fork PR, a contributor can commit
 * a CODEOWNERS that names arbitrary `@user`/`@org/team` handles. The parser is
 * therefore hand-rolled (no dependency), tolerant of malformed input, and never
 * throws. {@link loadCodeowners} is fail-soft: ANY error (404, parse failure,
 * network) collapses to `[]` rules + a `core.warning`.
 *
 * Matching mirrors GitHub's CODEOWNERS semantics: for each file, the LAST
 * matching pattern in the file wins. Patterns support gitignore-style globs via
 * the existing `picomatch` dependency (the same engine `glob.js` uses):
 *   - `*` matches within a single path segment
 *   - `**` matches across segments
 *   - `?` matches one char
 *   - `{a,b}` brace expansion
 *   - `src/` (trailing slash) matches everything under `src/` recursively
 *
 * @module src/lib/codeowners.js
 */

import picomatch from 'picomatch';
import { fetchRepoText, resolveHeadSha } from './repo-file.js';

/** Hard cap on the size of a CODEOWNERS file we will parse (cost/DoS guard). */
const MAX_CODEOWNERS_BYTES = 256 * 1024; // 256 KiB

/**
 * Candidate CODEOWNERS paths, searched in this order (GitHub's documented
 * precedence: .github/CODEOWNERS first, then root CODEOWNERS, then
 * docs/CODEOWNERS). W5-6: the previous order checked root first, which
 * diverged from GitHub when both root and .github copies exist.
 * See https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners
 */
export const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

/* ------------------------------------------------------------------ *
 * parseCodeowners
 * ------------------------------------------------------------------ */

/**
 * Strip a trailing CODEOWNERS `# ...` comment from a line. A `#` only starts a
 * comment when it is at the start of the line or preceded by whitespace
 * (mirrors the convention used throughout this codebase; `value#frag` is NOT
 * a comment). The `#` itself never appears in a valid owner handle.
 *
 * @param {string} line
 * @returns {string}
 */
function stripComment(line) {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '#') {
      const prev = i > 0 ? line[i - 1] : '';
      if (i === 0 || /\s/.test(prev)) {
        return line.slice(0, i);
      }
    }
  }
  return line;
}

/**
 * W17-C3-2: a VALID owner token shape — `@login` or `@org/team`, each segment
 * being a GitHub handle (`[\w.-]+`). CODEOWNERS is untrusted fork-PR content;
 * keeping any `@`-prefixed token verbatim let a forged token like
 * `@r[x](https://evil.phish)` (or an image beacon) ride into the
 * "Suggested reviewers" line rendered in the trusted review summary. Tokens
 * that fail the grammar check are DROPPED at parse time (fail-soft: a line
 * whose owners are all invalid just has no owners; the pattern still matches
 * files, same shape as an intentionally unowned pattern).
 *
 * @type {RegExp}
 */
const OWNER_TOKEN_RE = /^@[\w.-]+(?:\/[\w.-]+)?$/;

/**
 * Parse a CODEOWNERS document into `[{pattern, owners}]`, in file order.
 *
 * Tolerant of malformed input and NEVER throws. Returns `[]` for non-string
 * input, empty input, or documents with no valid lines.
 *
 * Each line:
 *   - comment lines (`# ...`) are skipped
 *   - inline comments (` ... # note`) are stripped (whitespace-prefixed `#`)
 *   - blank lines (after comment-strip) are skipped
 *   - the first whitespace-separated token is the `pattern`; trailing tokens
 *     matching a valid `@login` / `@org/team` shape (W17-C3-2) are the
 *     `owners`. A line with no pattern is skipped.
 *     Backslash-escaped spaces (`\ `) are preserved within a token.
 *   - a pattern with no `@`-owners yields `owners: []` (still a valid rule —
 *     CODEOWNERS permits unowned patterns; they "match" with empty owners).
 *
 * Pure (exported for testing).
 *
 * @param {string} text
 * @returns {Array<{pattern: string, owners: string[]}>}
 */
export function parseCodeowners(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const out = [];
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const stripped = stripComment(raw).trim();
    if (stripped === '') continue;
    // Split on UN-escaped runs of whitespace (so `src/foo\ bar/` stays one
    // token). A backslash-escaped space (`\ `) is part of the path; replace
    // it with a literal space after splitting.
    const tokens = stripped
      .split(/(?<!\\)\s+/)
      .map((t) => t.replace(/\\ /g, ' '));
    const pattern = tokens[0];
    if (!pattern) continue;
    // Only `@`-prefixed tokens are owners; bare emails/handles are dropped.
    // W17-C3-2: additionally require a valid handle grammar (OWNER_TOKEN_RE)
    // so a forged `@r[x](https://evil.phish)` token cannot ride into the
    // trusted "Suggested reviewers" line.
    const owners = tokens.slice(1).filter((t) => OWNER_TOKEN_RE.test(t));
    out.push({ pattern, owners });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * matchCodeowners
 * ------------------------------------------------------------------ */

/**
 * Convert a CODEOWNERS pattern into a picomatch glob.
 *
 * GitHub's CODEOWNERS treats a trailing slash (`src/`) as "everything under
 * `src/` recursively" — picomatch expresses that as `src/**`. A pattern
 * without a trailing slash is passed through unchanged (picomatch already
 * understands `*`, `**`, `?`, `{a,b}`). A bare `*` stays `*` and matches any
 * top-level file.
 *
 * CODEOWNERS does NOT support gitignore-style `!` negation, but picomatch
 * interprets a leading `!` as negation. To keep CODEOWNERS semantics (and to
 * keep an attacker-controllable CODEOWNERS from emitting "match everything"
 * negation patterns), any leading run of `!` is stripped before compiling.
 *
 * @param {string} pattern
 * @returns {string}
 */
function toGlob(pattern) {
  let p = pattern;
  // Strip leading `!` (CODEOWNERS has no negation; picomatch would mis-read it).
  p = p.replace(/^!+/, '');
  // W5-13: GitHub CODEOWNERS allows a leading `/` to root-anchor a pattern
  // (e.g. `/src/`). picomatch treats a leading `/` as significant and the
  // compiled regex then fails to match `src/deep/file.js`. CODEOWNERS paths
  // are always repo-relative, so a leading `/` carries no information beyond
  // "anchored at root" — which is already the default for picomatch paths
  // without a leading `**/`. Strip it.
  p = p.replace(/^\/+/, '');
  if (p.endsWith('/')) return `${p}**`;
  return p;
}

/**
 * Compile (memoized) a picomatch matcher for a CODEOWNERS pattern. We test each
 * changed file against BOTH the full path and the basename (OR) — mirroring the
 * `glob.js` convention so `*.js` matches both `foo.js` and `src/foo.js`.
 *
 * @param {string} pattern
 * @returns {(filename: string) => boolean}
 */
const matcherCache = new Map();
function matcherFor(pattern) {
  let fn = matcherCache.get(pattern);
  if (fn) return fn;
  const glob = toGlob(pattern);
  try {
    const re = picomatch.makeRe(glob, { dot: true });
    fn = (filename) => {
      if (!re) return false;
      if (re.test(filename)) return true;
      // basename match (same convention as matchesAnyPattern in glob.js).
      const slash = filename.lastIndexOf('/');
      if (slash >= 0 && slash + 1 < filename.length) {
        return re.test(filename.slice(slash + 1));
      }
      return false;
    };
  } catch {
    fn = () => false;
  }
  matcherCache.set(pattern, fn);
  return fn;
}

/**
 * For each changed file, find the matching CODEOWNERS rules (LAST match wins,
 * matching GitHub's behavior) and return a Map of `filename -> owners[]`.
 *
 * Files with no match are omitted from the Map (a `has(key)` check distinguishes
 * "no rule matched" from "matched an unowned rule → owners: []").
 *
 * Never throws; tolerates non-array inputs (returns an empty Map).
 *
 * Pure (exported for testing).
 *
 * @param {Array<{pattern: string, owners: string[]}>} codeownersRules
 * @param {string[]} changedFiles
 * @returns {Map<string, string[]>}
 */
export function matchCodeowners(codeownersRules, changedFiles) {
  const out = new Map();
  if (!Array.isArray(codeownersRules) || !Array.isArray(changedFiles)) {
    return out;
  }
  if (codeownersRules.length === 0 || changedFiles.length === 0) {
    return out;
  }

  for (const filename of changedFiles) {
    if (typeof filename !== 'string' || filename.length === 0) continue;
    let lastOwners = null; // null = no match yet; [] = matched an unowned rule
    for (const rule of codeownersRules) {
      if (!rule || typeof rule.pattern !== 'string') continue;
      const match = matcherFor(rule.pattern);
      if (match(filename)) {
        lastOwners = Array.isArray(rule.owners) ? rule.owners.slice() : [];
      }
    }
    if (lastOwners !== null) {
      out.set(filename, lastOwners);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * suggestReviewers
 * ------------------------------------------------------------------ */

/**
 * Aggregate unique owners across all changed files.
 *
 * Returns `{suggestedReviewers, byFile}` where `suggestedReviewers` is the
 * de-duplicated owner list (order = first-seen across files in iteration
 * order) and `byFile` is the Map from {@link matchCodeowners}.
 *
 * Owners from matched-but-unowned patterns (empty `owners: []`) contribute
 * nothing; only non-empty owner lists are aggregated.
 *
 * Never throws; tolerates non-array inputs.
 *
 * Pure (exported for testing).
 *
 * @param {string[]} changedFiles
 * @param {Array<{pattern: string, owners: string[]}>} codeownersRules
 * @returns {{suggestedReviewers: string[], byFile: Map<string, string[]>}}
 */
export function suggestReviewers(changedFiles, codeownersRules) {
  const byFile = matchCodeowners(codeownersRules, changedFiles);
  const suggestedReviewers = [];
  const seen = new Set();
  for (const owners of byFile.values()) {
    if (!Array.isArray(owners)) continue;
    for (const owner of owners) {
      if (typeof owner !== 'string' || owner.length === 0) continue;
      if (seen.has(owner)) continue;
      seen.add(owner);
      suggestedReviewers.push(owner);
    }
  }
  return { suggestedReviewers, byFile };
}

/* ------------------------------------------------------------------ *
 * Suggestion rendering / selection helpers
 * ------------------------------------------------------------------ */

/**
 * Render a "Suggested reviewers" line for the review/comment body.
 *
 * Returns an empty string when `owners` is empty (so callers can always
 * concatenate the result). The line lists every owner handle verbatim
 * (already `@`-prefixed from the CODEOWNERS file). Pure (exported for testing).
 *
 * @param {string[]} owners
 * @returns {string}
 */
export function formatSuggestedReviewersLine(owners) {
  if (!Array.isArray(owners) || owners.length === 0) return '';
  return `**Suggested reviewers:** ${owners.join(', ')}`;
}

/**
 * Select the owners that can be passed to `pulls.requestReviewers`.
 *
 * The GitHub `requestReviewers` API accepts `reviewers` (user logins, no `@`)
 * and `team_reviewers` (team slugs, no `@org/`). Team assignment requires
 * extra org-level permissions the bot may not have, so we surface teams in the
 * summary only and forward USERS to the assignment API. An owner qualifies as a
 * user handle iff it is `@name` with no slash. Returns the logins WITHOUT the
 * leading `@` (the API expects bare logins).
 *
 * Pure (exported for testing).
 *
 * @param {string[]} owners
 * @returns {string[]}
 */
export function pickAssignableReviewers(owners) {
  if (!Array.isArray(owners) || owners.length === 0) return [];
  const out = [];
  const seen = new Set();
  for (const raw of owners) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    // Strip a single leading `@`. (Handles from CODEOWNERS are `@login` or
    // `@org/team`.) A user handle has no `/`.
    const handle = raw.startsWith('@') ? raw.slice(1) : raw;
    if (handle.includes('/')) continue; // team — summary only
    if (handle.length === 0) continue;
    if (seen.has(handle)) continue;
    seen.add(handle);
    out.push(handle);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * loadCodeowners
 * ------------------------------------------------------------------ */

/**
 * Load + parse the CODEOWNERS file from the PR's HEAD SHA. Treated as UNTRUSTED.
 *
 * Searches `CODEOWNERS`, `.github/CODEOWNERS`, `docs/CODEOWNERS` in order and
 * returns the parsed rules from the FIRST path that exists. The fetch uses the
 * PR head SHA as `ref` so the suggestion reflects the PR's OWN CODEOWNERS (not
 * the base branch's).
 *
 * On ANY error (no file found, network failure, oversized, decode error) this
 * function NEVER throws: it calls `deps.core.warning(...)` and returns `[]`.
 *
 * @param {Object} opts - `{ octokit, context, headSha? }`
 * @param {Object} [deps] - `{ core }` (for warnings).
 * @param {{warning?: Function, info?: Function}} [deps.core]
 * @returns {Promise<Array<{pattern: string, owners: string[]}>>}
 */
export async function loadCodeowners(opts = {}, deps = {}) {
  const { octokit, context } = opts;
  const core = deps.core;
  const warn = (msg) => {
    if (core && typeof core.warning === 'function') core.warning(msg);
  };

  const owner = context?.repo?.owner;
  const repo = context?.repo?.repo;
  if (!owner || !repo) {
    warn('codeowners: missing owner/repo in context; skipping CODEOWNERS load.');
    return [];
  }

  const headSha = resolveHeadSha(opts);
  if (headSha === '') {
    warn('codeowners: could not resolve PR head SHA; skipping CODEOWNERS load.');
    return [];
  }

  let text = null;
  let foundPath = null;
  for (const path of CODEOWNERS_PATHS) {
    const outcome = await fetchRepoText({
      octokit,
      owner,
      repo,
      path,
      ref: headSha,
      maxBytes: MAX_CODEOWNERS_BYTES,
      label: 'CODEOWNERS',
    });
    if (outcome.ok) {
      // F-REPOFILE alignment: a raw-string payload (non-base64 `data`) now
      // loads too — the learnings/repo-config convention, adopted everywhere.
      text = outcome.text;
      foundPath = path;
      break;
    }
    if (outcome.kind === 'missing') continue; // not at this path — try the next candidate
    // too-large / decode / error — the historical outer-catch warn shape.
    warn(`codeowners: failed to fetch CODEOWNERS: ${outcome.message}`);
    return [];
  }

  if (text === null) {
    warn(
      `codeowners: no CODEOWNERS found at ${headSha.slice(0, 7)} ` +
        `(tried ${CODEOWNERS_PATHS.join(', ')}).`,
    );
    return [];
  }

  let parsed;
  try {
    parsed = parseCodeowners(text);
  } catch (error) {
    // parseCodeowners is never expected to throw, but defend in depth.
    warn(
      `codeowners: ${foundPath} failed to parse: ${error?.message ?? String(error)}`,
    );
    return [];
  }
  return parsed;
}
