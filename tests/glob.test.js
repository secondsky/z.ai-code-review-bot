import { matchesAnyPattern } from '../src/lib/glob.js';
// Imported for end-to-end exclude-list tests that exercise the REAL
// matchesAnyPattern against whole file lists (same style as
// changed-files.test.js, which documents that contract).
import { filterExcludedFiles } from '../src/lib/changed-files.js';

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

  // ------------------------------------------------------------------
  // W5-1: a bare `!` pattern (no following glob) must not throw. After the
  // leading-`!` strip the positive form is the empty string, and picomatch
  // throws "Expected pattern to be a non-empty string" on empty patterns.
  // matchesAnyPattern's contract is to never throw on untrusted input (it
  // is fed .zai/learnings.yml and .zai.yml glob values from fork PRs).
  // ------------------------------------------------------------------

  test('W5-1: a bare "!" pattern does not throw and matches nothing', () => {
    expect(() => matchesAnyPattern('foo.js', ['!'])).not.toThrow();
    expect(matchesAnyPattern('foo.js', ['!'])).toBe(false);
  });

  test('W5-1: a whitespace-only "!" pattern does not throw', () => {
    expect(() => matchesAnyPattern('foo.js', ['!   '])).not.toThrow();
    expect(matchesAnyPattern('foo.js', ['!   '])).toBe(false);
  });

  test('W5-1: bare "!" does not mask a valid sibling pattern', () => {
    // The empty positive from `!` is skipped; the real pattern still matches.
    expect(matchesAnyPattern('foo.lock', ['!', '*.lock'])).toBe(true);
  });

  test('W5-1: a picomatch-invalid pattern is tolerated (no throw, no match)', () => {
    // Defense in depth: even patterns picomatch rejects at compile time
    // (e.g. unmatched `[`) must not crash the review pipeline.
    expect(() => matchesAnyPattern('foo.js', ['[unclosed'])).not.toThrow();
  });

  // ------------------------------------------------------------------
  // W15-A2-1: picomatch isMatch must be called with { dot: true }. With the
  // default dot:false, neither `*` nor `**` matches path segments that BEGIN
  // with a dot, so maintainer excludes like `dist/**` silently missed
  // dotfiles and dot-directories (dist/.gitkeep, dist/.vite/manifest.json,
  // .cache/...). The sibling codeowners.js already compiles with
  // { dot: true }; matchesAnyPattern is aligned here. Pinned below are the
  // ACTUAL picomatch dot:true semantics (verified against picomatch 4.0.5):
  // enabling dot lets stars span leading dots, so `dist/**` crosses the
  // `.vite` segment AND `*.js` also matches `.hidden.js` (a leading-dot
  // file whose extension the pattern names). Explicit dotfile patterns
  // (e.g. `.*`) keep working.
  // ------------------------------------------------------------------

  test('W15-A2-1: dist/** matches dotfiles and dot-directories under dist/', () => {
    expect(matchesAnyPattern('dist/.vite/manifest.json', ['dist/**'])).toBe(true);
    expect(matchesAnyPattern('dist/.gitkeep', ['dist/**'])).toBe(true);
    expect(matchesAnyPattern('dist/.cache/a.js', ['dist/**'])).toBe(true);
  });

  test('W15-A2-1: filterExcludedFiles drops dist/ and node_modules/ dotfiles (end-to-end)', () => {
    const files = [
      { filename: 'src/app.js' },
      { filename: 'dist/.gitkeep' },
      { filename: 'dist/.vite/manifest.json' },
      { filename: 'node_modules/.package-lock.json' },
    ];
    const out = filterExcludedFiles(files, ['dist/**', 'node_modules/**']);
    expect(out.map((f) => f.filename)).toEqual(['src/app.js']);
  });

  test('W15-A2-1: picomatch dot:true semantics — *.js spans leading dots for dotfiles', () => {
    // Verified against picomatch 4.0.5: with { dot: true } a star MAY match a
    // leading dot. `*.js` therefore now ALSO matches `.hidden.js` (via the
    // basename AND the full path). This is the same trade codeowners.js
    // already makes; pinning it guards against accidental option loss.
    expect(matchesAnyPattern('a.js', ['*.js'])).toBe(true); // unchanged
    expect(matchesAnyPattern('.hidden.js', ['*.js'])).toBe(true); // dot:true semantics
  });

  test('W15-A2-1: explicit dotfile patterns keep working (learnings globs)', () => {
    // A pattern that itself starts with a literal `.` already matched dotfiles
    // before the fix (the dot was explicit, not star-crossed). Still true.
    expect(matchesAnyPattern('.gitignore', ['.*'])).toBe(true);
    expect(matchesAnyPattern('.zai.yml', ['.*.yml'])).toBe(true);
    // ...and a non-dot file is still NOT matched by an explicit-dot pattern.
    expect(matchesAnyPattern('zai.yml', ['.*.yml'])).toBe(false);
  });

  // ------------------------------------------------------------------
  // W15-A2-2: ALL leading `!`s must be stripped. Stripping only one left
  // `!!dist/**` as `!dist/**`, which picomatch reads as the negation "not
  // under dist/" — combined with the basename-OR fallback it matched EVERY
  // file, so filterExcludedFiles returned [] (entire PR silently
  // unreviewed). Stripping all `!`s makes `!!dist/**` behave as the plain
  // pattern `dist/**`.
  // ------------------------------------------------------------------

  test('W15-A2-2: !!dist/** behaves as dist/** (all leading !s stripped)', () => {
    expect(matchesAnyPattern('dist/b.js', ['!!dist/**'])).toBe(true);
    expect(matchesAnyPattern('src/a.js', ['!!dist/**'])).toBe(false);
    // Three leading !s collapse to the plain pattern too.
    expect(matchesAnyPattern('dist/b.js', ['!!!dist/**'])).toBe(true);
    expect(matchesAnyPattern('src/a.js', ['!!!dist/**'])).toBe(false);
  });

  test('W15-A2-2: filterExcludedFiles with !!dist/** keeps src/ and drops dist/ (end-to-end)', () => {
    // Before the fix this dropped BOTH files (the half-stripped `!dist/**`
    // matched everything), leaving the whole PR unreviewed.
    const files = [
      { filename: 'src/a.js' },
      { filename: 'dist/b.js' },
    ];
    const out = filterExcludedFiles(files, ['!!dist/**']);
    expect(out.map((f) => f.filename)).toEqual(['src/a.js']);
  });

  // ------------------------------------------------------------------
  // W15-A2-3: POSIX bracket negation `[!d]` must behave like `[^d]`.
  // picomatch v4 only special-cases `[^` inside a class; an unnormalized
  // `[!a]` compiles as the POSITIVE class {'!','a'} — exactly backwards vs
  // bash/minimatch. We normalize an UNESCAPED `[!` to `[^` before matching;
  // `[^...]` (already correct) and escaped `\[!...\]` (literal bracket) are
  // untouched.
  // ------------------------------------------------------------------

  test('W15-A2-3: [!a]*.js is a negated class (matches b.js, NOT a.js)', () => {
    expect(matchesAnyPattern('b.js', ['[!a]*.js'])).toBe(true);
    expect(matchesAnyPattern('a.js', ['[!a]*.js'])).toBe(false);
    // The `[^...]` spelling was always correct and stays correct.
    expect(matchesAnyPattern('b.js', ['[^a]*.js'])).toBe(true);
    expect(matchesAnyPattern('a.js', ['[^a]*.js'])).toBe(false);
  });

  test('W15-A2-3: filterExcludedFiles with [!d]*.js keeps only d-prefixed files (end-to-end)', () => {
    const files = [
      { filename: 'a.js' },
      { filename: 'b.js' },
      { filename: 'd1.js' },
    ];
    const out = filterExcludedFiles(files, ['[!d]*.js']);
    expect(out.map((f) => f.filename)).toEqual(['d1.js']);
  });

  test('W15-A2-3: an escaped \\[!a\\] pattern still matches the literal "[!a]" (no over-normalization)', () => {
    // The `[` is backslash-escaped, so it is a LITERAL bracket — the `!`
    // right after it must NOT be rewritten to `^`. (Verified picomatch
    // behavior: '\[!a\]' matches the filename '[!a]'.)
    expect(matchesAnyPattern('[!a]', ['\\[!a\\]'])).toBe(true);
    expect(matchesAnyPattern('a', ['\\[!a\\]'])).toBe(false);
  });
});
