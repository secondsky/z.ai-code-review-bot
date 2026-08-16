import path from 'node:path';
import picomatch from 'picomatch';

/**
 * Normalize POSIX bracket negation `[!...]` to picomatch's `[^...]` spelling.
 *
 * picomatch v4 only special-cases `^` as the negation prefix inside a
 * character class; an unnormalized `[!a]` compiles as the POSITIVE class
 * {'!','a'} — exactly backwards vs bash/minimatch, so an exclude like
 * `[!d]*.js` silently kept exactly the files it was meant to drop (W15-A2-3).
 *
 * Only an `!` IMMEDIATELY after an UNESCAPED `[` is rewritten. Backslash
 * escapes are consumed pairwise, so `\[!a\]` (a literal-bracket pattern) is
 * left untouched; a `!` elsewhere in the class stays a literal member; and
 * the already-correct `[^...]` spelling passes through unchanged.
 *
 * @param {string} pattern
 * @returns {string}
 */
function normalizeBracketNegation(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    // Consume escaped characters pairwise so an escaped `\[` is a literal
    // bracket, not the start of a class.
    if (ch === '\\' && i + 1 < pattern.length) {
      out += ch + pattern[i + 1];
      i++;
      continue;
    }
    if (ch === '[' && pattern[i + 1] === '!') {
      out += '[^';
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Returns true if `filename` matches ANY of the given glob `patterns`.
 *
 * Matching mirrors the upstream action's behavior: each pattern is tested
 * against both the full path AND the basename (OR), so a pattern like
 * `*.lock` matches both `foo.lock` and `src/foo.lock`.
 *
 * Blank/whitespace-only patterns match nothing and are skipped. Non-string
 * filenames and non-array pattern lists are tolerated (return false) and never
 * throw.
 *
 * ALL leading `!`s (picomatch negation) are STRIPPED before testing. This
 * predicate is an "include if any pattern matches" check used by
 * `filterExcludedFiles` as an exclude-list: picomatch negation semantics
 * ("match any file NOT matching this pattern") would invert the intent,
 * causing `!dist/**` to exclude every file outside `dist/`. Stripping the
 * `!`s makes `!dist/**` behave as `dist/**` (and a malformed `!!dist/**`
 * as `dist/**`, not "not under dist/"), which is what callers documenting
 * the `!dist/**` exclude syntax expect. (CFG-1 / SCN-13, W15-A2-2.)
 *
 * @param {string} filename - Full path or basename of the file to test.
 * @param {string[]} patterns - Glob patterns (picomatch syntax).
 * @returns {boolean}
 */
export function matchesAnyPattern(filename, patterns) {
  if (typeof filename !== 'string' || !Array.isArray(patterns)) {
    return false;
  }

  const base = path.basename(filename);

  for (const pattern of patterns) {
    if (typeof pattern !== 'string') {
      continue;
    }
    const trimmed = pattern.trim();
    if (trimmed === '') {
      continue;
    }
    // Strip ALL leading `!`s (picomatch negation). Negation is not meaningful
    // for an "include if any matches" / exclude-list predicate and would
    // invert the caller's intent (CFG-1 / SCN-13). Stripping only one left a
    // malformed `!!dist/**` as `!dist/**` ("NOT under dist/"), which matched
    // every file via the basename-OR fallback and silently emptied the PR;
    // stripping all `!`s makes `!!dist/**` behave as `dist/**` (W15-A2-2).
    let positive = trimmed;
    while (positive.startsWith('!')) positive = positive.slice(1);
    // W5-1: a bare `!` (or `!   `) yields an empty positive after stripping.
    // picomatch throws on empty patterns, which would crash the review when
    // this predicate is fed untrusted globs (.zai.yml path_filters,
    // .zai/learnings.yml file globs). Skip empties; never throw.
    if (positive === '') continue;
    // W15-A2-3: rewrite POSIX `[!...]` negation to picomatch's `[^...]`.
    positive = normalizeBracketNegation(positive);
    // Defense in depth: picomatch can also throw on syntactically invalid
    // patterns (e.g. an unmatched `[`). Treat a compile error as "no match"
    // so a malformed untrusted pattern can never break the review pipeline.
    let isMatch;
    try {
      // W15-A2-1: { dot: true } so `**` crosses dot-directories and stars can
      // span leading dots — without it, `dist/**` silently missed dotfiles
      // (dist/.gitkeep, dist/.vite/manifest.json). Aligned with codeowners.js,
      // which already compiles its patterns with { dot: true }.
      isMatch =
        picomatch.isMatch(filename, positive, { dot: true }) ||
        picomatch.isMatch(base, positive, { dot: true });
    } catch {
      continue;
    }
    if (isMatch) return true;
  }
  return false;
}
