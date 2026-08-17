import { describe, it, expect } from 'vitest';
import { stripComment, unquote } from '../src/lib/yaml-lex.js';

/* ------------------------------------------------------------------ *
 * yaml-lex — shared comment-strip + unquote idioms
 *
 * These cases are ported from the quote-handling tests in
 * tests/learnings.test.js (W15 parser hardening) so the shared module — now
 * imported by both repo-config.js and learnings.js — carries its own coverage.
 * ------------------------------------------------------------------ */

describe('stripComment — quote handling', () => {
  // NOTE: stripComment slices at the `#` index and keeps any whitespace
  // before it; the parsers (parseZaiYml / parseLearnings) trim the result.
  // The expectations below intentionally include that trailing space.
  // W8-4: an apostrophe glued to a word character (a contraction like `it's`)
  // must not toggle the single-quote state and disable comment stripping.
  it('W8-4: an apostrophe in a contraction does not disable comment stripping', () => {
    expect(stripComment("tone: don't do this # note")).toBe(
      "tone: don't do this "
    );
  });

  // W12-4b: inside a single-quoted value, a `'` glued to a word char is still
  // the closing delimiter — the W8-4 guard must not keep inSingle stuck true.
  it("W12-4b: a quote glued to a word inside a single-quoted value still closes it", () => {
    expect(stripComment("tone: 'see ref5'   # note")).toBe("tone: 'see ref5'   ");
  });

  // W15-A6-6: a double quote glued to a word character (the inches mark in
  // `5" floppy`) must not toggle the double-quote state; the trailing comment
  // is still stripped.
  it('W15-A6-6: a double quote glued to a word does not disable comment stripping', () => {
    expect(stripComment('tone: use 5" floppy # legacy note')).toBe(
      'tone: use 5" floppy '
    );
  });

  it('W15-A6-6: a properly-quoted value still strips a real trailing comment', () => {
    expect(stripComment('tone: "x # not comment" # real comment')).toBe(
      'tone: "x # not comment" '
    );
  });

  it('W15-A6-6: quoted words inside an unquoted value keep comment stripping', () => {
    expect(stripComment('reason: He said "hi" # note')).toBe(
      'reason: He said "hi" '
    );
  });

  it('preserves # inside quoted strings', () => {
    expect(stripComment('tone: "use # for headers"')).toBe(
      'tone: "use # for headers"'
    );
  });

  it('does not treat a mid-word # as a comment (YAML 1.2)', () => {
    expect(stripComment('url: https://x.test/a#anchor')).toBe(
      'url: https://x.test/a#anchor'
    );
  });

  it('strips full-line and inline comments', () => {
    expect(stripComment('# whole line')).toBe('');
    expect(stripComment('profile: chill # the relaxed profile')).toBe(
      'profile: chill '
    );
  });

  it('returns the line unchanged when there is no comment', () => {
    expect(stripComment('profile: chill')).toBe('profile: chill');
  });
});

describe('unquote — scalar unquoting', () => {
  it('strips matching surrounding double quotes', () => {
    expect(unquote('"chill"')).toBe('chill');
  });

  it("strips matching surrounding single quotes", () => {
    expect(unquote("'be nice'")).toBe('be nice');
  });

  it('returns the input unchanged when not quoted', () => {
    expect(unquote('chill')).toBe('chill');
  });

  it('returns mismatched quote pairs unchanged', () => {
    expect(unquote('"chill\'')).toBe('"chill\'');
  });

  it('returns short and non-string inputs unchanged', () => {
    expect(unquote('"')).toBe('"');
    expect(unquote('')).toBe('');
    expect(unquote(null)).toBe(null);
    expect(unquote(5)).toBe(5);
  });
});
