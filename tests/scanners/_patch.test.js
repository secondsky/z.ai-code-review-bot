/**
 * Tests for the shared patch-parsing helper (src/lib/scanners/_patch.js).
 *
 * Used by both the secrets and patterns scanners to enumerate added lines with
 * their absolute (new-file) line numbers.
 */
import { describe, it, expect } from 'vitest';
import { parseHunkHeader, parseAddedLines } from '../../src/lib/scanners/_patch.js';

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

  it('skips the +++ file header', () => {
    // Hunk starts new-file line at 1; `+++` header is not an addition and does
    // NOT advance the counter; `+real addition` therefore lands at line 1.
    const patch = ['@@ -1,1 +1,1 @@', '+++ b/foo.js', '+real addition'].join('\n');
    expect(parseAddedLines(patch)).toEqual([{ line: 1, text: 'real addition' }]);
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
});
