import { matchesAnyPattern } from '../src/lib/glob.js';

describe('matchesAnyPattern', () => {
  test('returns false for an empty pattern array', () => {
    expect(matchesAnyPattern('foo.lock', [])).toBe(false);
  });

  test('*.lock matches basename (foo.lock)', () => {
    expect(matchesAnyPattern('foo.lock', ['*.lock'])).toBe(true);
  });

  test('*.lock matches full path with basename (src/foo.lock)', () => {
    expect(matchesAnyPattern('src/foo.lock', ['*.lock'])).toBe(true);
  });

  test('*.lock does not match a non-matching file', () => {
    expect(matchesAnyPattern('src/foo.js', ['*.lock'])).toBe(false);
  });

  test('dist/** matches nested files under dist/', () => {
    expect(matchesAnyPattern('dist/a/b.js', ['dist/**'])).toBe(true);
    expect(matchesAnyPattern('dist/index.js', ['dist/**'])).toBe(true);
  });

  test('dist/** does not match files outside dist/', () => {
    expect(matchesAnyPattern('src/dist/index.js', ['dist/**'])).toBe(false);
  });

  test('* does not cross path separators (on full-path match)', () => {
    // Per spec, each pattern is tested against the full path AND the basename.
    // '*' does not cross '/', so by full path '*.js' must not match 'a/b.js'.
    // (It DOES match via the basename 'b.js' — covered by the basename tests.)
    // A pattern that cannot match the basename either proves the separator rule:
    expect(matchesAnyPattern('a/b.js', ['*/x.js'])).toBe(false);
    expect(matchesAnyPattern('a/b.js', ['c/*.js'])).toBe(false);
  });

  test('? matches exactly one character', () => {
    expect(matchesAnyPattern('a.js', ['?.js'])).toBe(true);
    expect(matchesAnyPattern('ab.js', ['?.js'])).toBe(false);
  });

  test('[a-z] character classes work', () => {
    expect(matchesAnyPattern('a.js', ['[a-z].js'])).toBe(true);
    expect(matchesAnyPattern('z.js', ['[a-z].js'])).toBe(true);
    expect(matchesAnyPattern('1.js', ['[a-z].js'])).toBe(false);
  });

  test('returns true if ANY pattern matches (OR semantics)', () => {
    expect(matchesAnyPattern('foo.lock', ['*.js', '*.lock'])).toBe(true);
    expect(matchesAnyPattern('foo.js', ['*.js', '*.lock'])).toBe(true);
    expect(matchesAnyPattern('foo.txt', ['*.js', '*.lock'])).toBe(false);
  });

  test('blank/whitespace patterns match nothing', () => {
    expect(matchesAnyPattern('foo.lock', ['', '  '])).toBe(false);
    expect(matchesAnyPattern('foo.lock', ['  ', '*.lock'])).toBe(true);
  });

  test('does not throw and returns false for non-string filename', () => {
    expect(matchesAnyPattern(null, ['*.lock'])).toBe(false);
    expect(matchesAnyPattern(undefined, ['*.lock'])).toBe(false);
    expect(matchesAnyPattern(42, ['*.lock'])).toBe(false);
  });

  test('does not throw for non-array patterns', () => {
    expect(matchesAnyPattern('foo.lock', null)).toBe(false);
    expect(matchesAnyPattern('foo.lock', undefined)).toBe(false);
  });

  test('skips non-string entries inside the patterns array (no throw)', () => {
    // A non-string element must be skipped, not crash picomatch.
    expect(matchesAnyPattern('foo.lock', [null, 42, '*.lock'])).toBe(true);
    expect(matchesAnyPattern('foo.js', [null, 42])).toBe(false);
  });

  // ------------------------------------------------------------------
  // CFG-1 / SCN-13: negation (`!`) patterns must NOT invert semantics in
  // an exclude-list context. picomatch's `!` is a per-pattern negation
  // meaning "files NOT matching this"; when `filterExcludedFiles` calls
  // `matchesAnyPattern`, a `!dist/**` returning true for every file
  // outside `dist/` would EXCLUDE all those files — the opposite of the
  // documented intent. The fix: strip a leading `!` before testing, so a
  // negated pattern behaves as its positive counterpart.
  // ------------------------------------------------------------------

  test('CFG-1: a leading-! pattern does NOT match non-matching files (no semantic inversion)', () => {
    // `!dist/**` must NOT match `src/a.js`. Before the fix, picomatch
    // treated `!dist/**` as "any file not under dist/" → returned true →
    // filterExcludedFiles dropped src/a.js. After the fix, the `!` is
    // stripped and `dist/**` simply does not match `src/a.js`.
    expect(matchesAnyPattern('src/a.js', ['!dist/**'])).toBe(false);
  });

  test('CFG-1: a leading-! pattern matches when the stripped positive form matches', () => {
    // `!dist/**` should behave like `dist/**` for matching purposes.
    expect(matchesAnyPattern('dist/secret.js', ['!dist/**'])).toBe(true);
    expect(matchesAnyPattern('dist/sub/secret.js', ['!dist/**'])).toBe(true);
  });

  test('CFG-1: leading-! pattern mixed with positive patterns keeps OR semantics', () => {
    // `*.js` matches `src/app.js`; `!dist/**` after stripping behaves as
    // `dist/**` which does not match `src/app.js`. The OR of the two is true.
    expect(matchesAnyPattern('src/app.js', ['*.js', '!dist/**'])).toBe(true);
    // Neither `*.md` nor `!dist/**` (→ `dist/**`) matches `src/app.js`.
    expect(matchesAnyPattern('src/app.js', ['*.md', '!dist/**'])).toBe(false);
  });

  test('CFG-1: positive patterns (no leading !) are unaffected', () => {
    // Regression guard: non-negated patterns keep working exactly as before.
    expect(matchesAnyPattern('dist/secret.js', ['dist/**'])).toBe(true);
    expect(matchesAnyPattern('src/a.js', ['dist/**'])).toBe(false);
  });
});
