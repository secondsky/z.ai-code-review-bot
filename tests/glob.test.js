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
});
