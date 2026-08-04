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
    if (picomatch.isMatch(filename, trimmed) || picomatch.isMatch(base, trimmed)) {
      return true;
    }
  }
  return false;
}
