import path from 'node:path';
import picomatch from 'picomatch';

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
 * A leading `!` (picomatch negation) is STRIPPED before testing. This
 * predicate is an "include if any pattern matches" check used by
 * `filterExcludedFiles` as an exclude-list: picomatch negation semantics
 * ("match any file NOT matching this pattern") would invert the intent,
 * causing `!dist/**` to exclude every file outside `dist/`. Stripping
 * the `!` makes `!dist/**` behave as `dist/**`, which is what callers
 * documenting the `!dist/**` exclude syntax expect. (CFG-1 / SCN-13.)
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
    // Strip a leading `!` (picomatch negation). Negation is not meaningful
    // for an "include if any matches" / exclude-list predicate and would
    // invert the caller's intent (CFG-1 / SCN-13).
    const positive = trimmed.startsWith('!') ? trimmed.slice(1) : trimmed;
    if (picomatch.isMatch(filename, positive) || picomatch.isMatch(base, positive)) {
      return true;
    }
  }
  return false;
}
