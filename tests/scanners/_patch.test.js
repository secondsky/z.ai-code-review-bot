/**
 * Tests for the shared patch-parsing helper (src/lib/scanners/_patch.js).
 *
 * Used by both the secrets and patterns scanners to enumerate added lines with
 * their absolute (new-file) line numbers.
 */
import { describe, it, expect } from 'vitest';
import {
  parseHunkHeader,
  parseAddedLines,
  changedFileNames,
} from '../../src/lib/scanners/_patch.js';

describe('parseHunkHeader', () => {
  it('returns the +c start line from `@@ -a,b +c,d @@`', () => {
    expect(parseHunkHeader('@@ -10,5 +12,7 @@ fn')).toBe(12);
  });

  it('returns the +c when ,d is absent', () => {
    expect(parseHunkHeader('@@ -1 +5 @@')).toBe(5);
  });

  it('returns null for a non-hunk line', () => {
    expect(parseHunkHeader('context line')).toBeNull();
    expect(parseHunkHeader('')).toBeNull();
    expect(parseHunkHeader('--- a/foo.js')).toBeNull();
  });

  it('returns null when the + portion is missing', () => {
    expect(parseHunkHeader('@@ -10,5 @@')).toBeNull();
  });

  it('returns 0 for a +0,0 pure-deletion hunk header [SCN-5]', () => {
    // Git emits `+0,0` for pure-deletion hunks. Previously rejected (start<1),
    // which dropped all subsequent line tracking in multi-hunk patches.
    expect(parseHunkHeader('@@ -1,3 +0,0 @@')).toBe(0);
  });
});

describe('parseAddedLines', () => {
  it('returns [] for empty/invalid input', () => {
    expect(parseAddedLines('')).toEqual([]);
    expect(parseAddedLines(null)).toEqual([]);
    expect(parseAddedLines(undefined)).toEqual([]);
  });

  it('extracts added lines with absolute line numbers', () => {
    const patch = [
      '@@ -10,3 +12,5 @@ fn',
      ' context', // new line 12 (context)
      '-removed', // old-only, new counter unchanged
      '+added at 13', // new line 13
      ' context2', // new line 14
      '+added at 15', // new line 15
    ].join('\n');
    expect(parseAddedLines(patch)).toEqual([
      { line: 13, text: 'added at 13' },
      { line: 15, text: 'added at 15' },
    ]);
  });

  it('handles multiple hunks (counter resets per hunk)', () => {
    const patch = [
      '@@ -1,2 +1,2 @@',
      '+first at 1',
      ' ctx',
      '@@ -10,2 +20,2 @@',
      '+second at 20',
      ' ctx',
    ].join('\n');
    expect(parseAddedLines(patch)).toEqual([
      { line: 1, text: 'first at 1' },
      { line: 20, text: 'second at 20' },
    ]);
  });

  it('treats a +++ line INSIDE a hunk as an added line (W13-1: over-scan, not under-scan)', () => {
    // W13-1: real `+++ b/path` file headers appear BEFORE the first `@@` hunk
    // (skipped by !inHunk). Inside a hunk, a `+++` line is always an added line
    // whose content starts with `++`. Treating it as content is the SAFE
    // direction — it over-scans (harmless false positive) rather than
    // under-scanning (which would bypass secret detection). The added line
    // `+++ b/foo.js` has content `++ b/foo.js` which won't match any secret
    // pattern, so it's effectively a no-op for the scanner.
    const patch = ['@@ -1,1 +1,1 @@', '+++ b/foo.js', '+real addition'].join('\n');
    // Both lines are treated as additions.
    expect(parseAddedLines(patch)).toEqual([
      { line: 1, text: '++ b/foo.js' },
      { line: 2, text: 'real addition' },
    ]);
  });

  // W5-5: an ADDED line whose content starts with `++` (e.g. `++secret = ...`)
  // is emitted in the diff as `+++secret = ...` — which the old
  // `raw.startsWith('+++')` check misclassified as a file header, silently
  // dropping the line so the secret scanner never saw it. The genuine git
  // header form is `+++ b/path` (space-delimited). Only treat `+++` as a
  // header when a space or end-of-line follows.
  it('W5-5: an added line whose text starts with ++ is scanned (not a header)', () => {
    const patch = [
      '@@ -1,1 +1,2 @@',
      '-old();',
      '+++secret = "AKIAIOSFODNN7EXAMPLE";',
    ].join('\n');
    expect(parseAddedLines(patch)).toEqual([
      { line: 1, text: '++secret = "AKIAIOSFODNN7EXAMPLE";' },
    ]);
  });

  it('skips removed (–) and context lines', () => {
    // Hunk starts new-file at 1; `-removed` doesn't advance new counter;
    // ` context` advances to 2; `+added` is new line 2.
    const patch = [
      '@@ -1,3 +1,3 @@',
      '-removed',
      ' context',
      '+added',
    ].join('\n');
    expect(parseAddedLines(patch)).toEqual([{ line: 2, text: 'added' }]);
  });

  it('skips "\\ No newline at end of file" marker', () => {
    const patch = ['@@ -1,1 +1,2 @@', '+added', '\\ No newline at end of file'].join('\n');
    expect(parseAddedLines(patch)).toEqual([{ line: 1, text: 'added' }]);
  });

  it('ignores diff metadata before the first hunk', () => {
    const patch = [
      'diff --git a/foo.js b/foo.js',
      'index abc..def 100644',
      '--- a/foo.js',
      '+++ b/foo.js',
      '@@ -1,1 +1,1 @@',
      '+added at 1',
    ].join('\n');
    expect(parseAddedLines(patch)).toEqual([{ line: 1, text: 'added at 1' }]);
  });

  it('recovers from a malformed @@ header and still captures later additions [SCN-4]', () => {
    // A `@@`-prefixed line that fails to parse (no +c portion) as the FIRST
    // hunk previously left `inHunk` false, dropping ALL subsequent additions.
    // After the fix we recover (treat as a hunk with approximate line numbers)
    // so secrets/patterns in later additions are not silently dropped.
    const patch = [
      '@@ this is not a valid hunk header',
      '+secret line',
    ].join('\n');
    const out = parseAddedLines(patch);
    const texts = out.map((o) => o.text);
    expect(texts).withContext('malformed first @@ must not drop later additions').toContain('secret line');
  });

  it('recovers from a malformed @@ header appearing after a valid hunk [SCN-4]', () => {
    // Once inHunk is true, a later malformed @@ header must not reset it.
    const patch = [
      '@@ -1,3 +1,3 @@',
      '+first at 1',
      '@@ malformed',
      '+second at 2',
    ].join('\n');
    const out = parseAddedLines(patch);
    const texts = out.map((o) => o.text);
    expect(texts).toContain('first at 1');
    expect(texts).toContain('second at 2');
  });

  it('tracks lines across a multi-hunk patch whose first hunk is +0,0 [SCN-5]', () => {
    // Pure-deletion first hunk (`+0,0`) followed by a normal second hunk.
    // The second hunk's lines must be tracked at the correct absolute number.
    const patch = [
      '@@ -1,3 +0,0 @@',
      '-removed',
      '@@ -5,2 +10,2 @@',
      '+added at 10',
      ' ctx',
    ].join('\n');
    const out = parseAddedLines(patch);
    expect(out).toEqual([{ line: 10, text: 'added at 10' }]);
  });

  it('strips a trailing \\r from CRLF patches so text has no \\r [SCN-12]', () => {
    // A CRLF patch: each line ends with \r\n. After split('\n') the lines
    // carry a trailing \r that must be stripped from the returned `text`.
    // Build the patch with an explicit trailing CRLF so the addition line
    // carries a \r after split('\n').
    const patch = '@@ -1,1 +1,1 @@\r\n+added line\r\n';
    const out = parseAddedLines(patch);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('added line');
    expect(out[0].text).not.toContain('\r');
  });

  // W12-4: the header guard /^\+\+\+(?:\s|$)/ matched a diff line "+++" as a
  // false file header, dropping the added line whose content is "++". A real
  // file header always has whitespace + a path after "+++".
  it('W12-4: does not drop an added line whose content is "++" (diff line +++)', () => {
    const patch = '@@ -1,1 +1,1 @@\n-old\n+++';
    const lines = parseAddedLines(patch);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('++');
  });

  // W13-1: the W12-4 fix (tightening the guard to /^\+\+\+\s+\S/) introduced a
  // Critical regression — it runs INSIDE the hunk where real +++ b/path headers
  // never appear (they're before the first @@). So it skips legitimate added
  // lines whose content starts with "++ " (e.g. "++ AKIAIOSFODNN7EXAMPLE"),
  // bypassing secret scanning on the regex-fallback path.
  it('W13-1: does NOT skip an added line whose content starts with "++ " (secret bypass)', () => {
    const patch = '@@ -1,1 +1,2 @@\n context\n+++ AKIAIOSFODNN7EXAMPLE';
    const lines = parseAddedLines(patch);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('++ AKIAIOSFODNN7EXAMPLE');
  });
});

describe('changedFileNames [W15-A5-1]', () => {
  it('builds a Set of filenames from GitHub PR file objects', () => {
    const set = changedFileNames([
      { filename: 'src/a.js', patch: '@@ hunk' },
      { filename: 'src/b.ts' },
    ]);
    expect(set).toBeInstanceOf(Set);
    expect(set.has('src/a.js')).toBe(true);
    expect(set.has('src/b.ts')).toBe(true);
    expect(set.has('legacy/old.js')).toBe(false);
  });

  it('skips entries without a usable filename and non-array input', () => {
    expect(changedFileNames([{ patch: 'x' }, null, { filename: '' }])).toEqual(new Set());
    expect(changedFileNames(null)).toEqual(new Set());
    expect(changedFileNames(undefined)).toEqual(new Set());
  });
});
