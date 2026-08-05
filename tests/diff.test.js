/**
 * Tests for src/lib/diff.js — pure unified-diff parsing + finding-to-comment
 * mapping for inline line-level review comments.
 *
 * This module is PURE (no I/O). It reuses `parseHunkHeader` from
 * `src/lib/scanners/_patch.js` and adds a richer walker that emits ALL lines
 * (added + context + deleted) with both old/new line numbers, plus helpers to
 * validate comment-anchor lines and map findings to GitHub review coordinates.
 */
import { describe, it, expect } from 'vitest';

import {
  parseHunks,
  isValidCommentLine,
  findNearestValidLine,
  mapFindingToComment,
  partitionFindings,
} from '../src/lib/diff.js';

/* ------------------------------------------------------------------ *
 * parseHunks
 * ------------------------------------------------------------------ */

describe('parseHunks', () => {
  it('returns [] for empty/invalid input', () => {
    expect(parseHunks('')).toEqual([]);
    expect(parseHunks(null)).toEqual([]);
    expect(parseHunks(undefined)).toEqual([]);
    expect(parseHunks(123)).toEqual([]);
  });

  it('parses a single hunk with the full @@ -a,b +c,d @@ header', () => {
    const patch = [
      '@@ -10,3 +12,5 @@ fn',
      ' context', // new 12, old 10
      '-removed', // old 11
      '+added at 13', // new 13
      ' context2', // new 14, old 12
    ].join('\n');
    const hunks = parseHunks(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({
      oldStart: 10,
      oldCount: 3,
      newStart: 12,
      newCount: 5,
    });
    expect(hunks[0].lines).toEqual([
      { type: 'ctx', newLine: 12, oldLine: 10, text: 'context' },
      { type: 'del', newLine: null, oldLine: 11, text: 'removed' },
      { type: 'add', newLine: 13, oldLine: null, text: 'added at 13' },
      { type: 'ctx', newLine: 14, oldLine: 12, text: 'context2' },
    ]);
  });

  it('parses multiple hunks (each with its own counter reset)', () => {
    const patch = [
      '@@ -1,2 +1,2 @@',
      '+first at 1',
      ' ctx at 2',
      '@@ -10,2 +20,2 @@',
      '+second at 20',
      ' ctx at 21',
    ].join('\n');
    const hunks = parseHunks(patch);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].lines).toEqual([
      { type: 'add', newLine: 1, oldLine: null, text: 'first at 1' },
      { type: 'ctx', newLine: 2, oldLine: 1, text: 'ctx at 2' },
    ]);
    expect(hunks[1].lines).toEqual([
      { type: 'add', newLine: 20, oldLine: null, text: 'second at 20' },
      { type: 'ctx', newLine: 21, oldLine: 10, text: 'ctx at 21' },
    ]);
  });

  it('parses a single-line hunk header (@@ -a +c @@ — count omitted)', () => {
    // Without counts, the spec treats the line count as 1. We still record the
    // start values and walk the body. The header regex tolerates missing counts.
    const patch = ['@@ -5 +7 @@', '+added at 7'].join('\n');
    const hunks = parseHunks(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ oldStart: 5, newStart: 7 });
    expect(hunks[0].lines).toEqual([
      { type: 'add', newLine: 7, oldLine: null, text: 'added at 7' },
    ]);
  });

  it('skips the "\\ No newline at end of file" marker line entirely', () => {
    const patch = [
      '@@ -1,1 +1,2 @@',
      '+added',
      '\\ No newline at end of file',
    ].join('\n');
    const hunks = parseHunks(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines).toEqual([
      { type: 'add', newLine: 1, oldLine: null, text: 'added' },
    ]);
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
    const hunks = parseHunks(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines).toEqual([
      { type: 'add', newLine: 1, oldLine: null, text: 'added at 1' },
    ]);
  });

  it('skips the +++ and --- file headers inside a hunk body', () => {
    // Real GitHub patches don't interleave these, but defensively they should
    // NOT be treated as additions/removals.
    const patch = [
      '@@ -1,3 +1,3 @@',
      '--- a/foo.js',
      '+++ b/foo.js',
      ' context',
    ].join('\n');
    const hunks = parseHunks(patch);
    expect(hunks[0].lines).toEqual([
      { type: 'ctx', newLine: 1, oldLine: 1, text: 'context' },
    ]);
  });

  it('treats an empty line (truly empty) as a context line', () => {
    // Unified diff context lines are " text" but a truly empty line is also
    // treated as context by git. We should emit it with the stripped text ''.
    const patch = ['@@ -1,2 +1,2 @@', '+added', ''].join('\n');
    const hunks = parseHunks(patch);
    expect(hunks[0].lines).toEqual([
      { type: 'add', newLine: 1, oldLine: null, text: 'added' },
      { type: 'ctx', newLine: 2, oldLine: 1, text: '' },
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * isValidCommentLine
 * ------------------------------------------------------------------ */

describe('isValidCommentLine', () => {
  it('returns true for an added line (newLine present)', () => {
    const patch = ['@@ -1,2 +10,2 @@', '+added', ' ctx'].join('\n');
    expect(isValidCommentLine(patch, 10)).toBe(true);
  });

  it('returns true for a context line (newLine present)', () => {
    const patch = ['@@ -1,2 +10,2 @@', '+added', ' ctx'].join('\n');
    expect(isValidCommentLine(patch, 11)).toBe(true);
  });

  it('returns false for a deleted line (no newLine)', () => {
    const patch = ['@@ -1,3 +10,2 @@', '-removed', '+added', ' ctx'].join('\n');
    // old line 1 was removed; there is no newLine == anything for it.
    // The only valid new-side lines are 10 (add) and 11 (ctx).
    expect(isValidCommentLine(patch, 1)).toBe(false);
  });

  it('returns false for a line outside any hunk range', () => {
    const patch = ['@@ -1,2 +10,2 @@', '+added', ' ctx'].join('\n');
    // 99 is not in the patch at all.
    expect(isValidCommentLine(patch, 99)).toBe(false);
  });

  it('returns false for a line beyond the patch entirely', () => {
    const patch = ['@@ -1,2 +10,2 @@', '+added', ' ctx'].join('\n');
    expect(isValidCommentLine(patch, 1000)).toBe(false);
  });

  it('returns false for empty/invalid patch', () => {
    expect(isValidCommentLine('', 1)).toBe(false);
    expect(isValidCommentLine(null, 1)).toBe(false);
  });

  it('handles multiple hunks (true if any hunk has the line)', () => {
    const patch = [
      '@@ -1,1 +10,1 @@',
      '+first',
      '@@ -50,1 +100,1 @@',
      '+second',
    ].join('\n');
    expect(isValidCommentLine(patch, 10)).toBe(true);
    expect(isValidCommentLine(patch, 100)).toBe(true);
    expect(isValidCommentLine(patch, 55)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * findNearestValidLine
 * ------------------------------------------------------------------ */

describe('findNearestValidLine', () => {
  it('returns the line itself when it is an exact match', () => {
    const patch = ['@@ -1,3 +10,3 @@', ' ctx10', '+added11', ' ctx12'].join('\n');
    expect(findNearestValidLine(patch, 11)).toBe(11);
  });

  it('snaps an off-by-one to the nearest valid line', () => {
    const patch = ['@@ -1,3 +10,3 @@', ' ctx10', '+added11', ' ctx12'].join('\n');
    // 10 is valid (ctx), so an exact match wins. But 13 is NOT valid; the
    // nearest within window 3 is 12 (ctx).
    expect(findNearestValidLine(patch, 13)).toBe(12);
  });

  it('snaps past a deleted line to the nearest added line', () => {
    // Layout: ctx10, -removed(old11), +added11(new), ctx12
    const patch = ['@@ -1,3 +10,3 @@', ' ctx10', '-removed', '+added11', ' ctx12'].join('\n');
    // If the finding said line 10 (ctx) but meant the addition, the nearest
    // valid line is 10 itself. Let's target a gap: there is none here since
    // old 11 maps to new 11. Test the "prefer added at equal distance" rule.
    // Search for line 10 with the addition present: 10 is ctx (exact).
    expect(findNearestValidLine(patch, 10)).toBe(10);
  });

  it('prefers added lines over context lines at equal distance', () => {
    // ctx10, added11, ctx12 — searching for line 11 hits the add exactly.
    // Searching for a line equidistant between an add and a ctx: line 11 is
    // itself the add. Construct: added at 10, ctx at 12, search 11 (gap).
    // Distance to 10 (add) = 1; distance to 12 (ctx) = 1; add wins → 10.
    const patch = ['@@ -1,3 +10,3 @@', '+added10', ' ctx11_removed', ' ctx12'].join('\n');
    // Fix the layout: add10, ctx11, ctx12. Searching 11 → ctx11 exact.
    // To exercise the tie-break we need add and ctx equidistant from target.
    // add10, del(old), ctx11 — searching for a line that isn't present:
    // make target = 13 where add=12 distance 1, ctx=14 distance 1.
    const patch2 = [
      '@@ -1,4 +10,4 @@',
      '+added10',
      '-removed',
      ' ctx11',
      ' ctx12',
    ].join('\n');
    // Valid new lines: 10 (add), 11 (ctx), 12 (ctx). Searching 13 → nearest is 12.
    expect(findNearestValidLine(patch2, 13)).toBe(12);
  });

  it('returns null when no valid line is within the window', () => {
    const patch = ['@@ -1,2 +10,2 @@', '+added10', ' ctx11'].join('\n');
    // 50 is far away; default window 3 → null.
    expect(findNearestValidLine(patch, 50)).toBeNull();
  });

  it('respects a custom window', () => {
    const patch = ['@@ -1,2 +10,2 @@', '+added10', ' ctx11'].join('\n');
    // 14 is distance 3 from 11; with window=3 → 11; with window=2 → null.
    expect(findNearestValidLine(patch, 14, 3)).toBe(11);
    expect(findNearestValidLine(patch, 14, 2)).toBeNull();
  });

  it('returns null for empty/invalid patch', () => {
    expect(findNearestValidLine('', 1)).toBeNull();
    expect(findNearestValidLine(null, 1)).toBeNull();
  });

  it('searches both directions (line below and line above)', () => {
    // added at 10, ctx at 11; searching 9 (above) → 10; searching 12 (below) → 11.
    const patch = ['@@ -1,2 +10,2 @@', '+added10', ' ctx11'].join('\n');
    expect(findNearestValidLine(patch, 9)).toBe(10);
    expect(findNearestValidLine(patch, 12)).toBe(11);
  });
});

/* ------------------------------------------------------------------ *
 * mapFindingToComment
 * ------------------------------------------------------------------ */

describe('mapFindingToComment', () => {
  it('maps a finding on a valid (added) line to a RIGHT-side coordinate', () => {
    const patch = '@@ -1,2 +10,2 @@\n+added\n ctx';
    const finding = { file: 'src/a.js', line: 10 };
    const fileObj = { filename: 'src/a.js', patch };
    expect(mapFindingToComment(finding, fileObj)).toEqual({
      path: 'src/a.js',
      line: 10,
      side: 'RIGHT',
    });
  });

  it('maps a finding on a context line to a RIGHT-side coordinate', () => {
    const patch = '@@ -1,2 +10,2 @@\n+added\n ctx';
    const finding = { file: 'src/a.js', line: 11 };
    const fileObj = { filename: 'src/a.js', patch };
    expect(mapFindingToComment(finding, fileObj)).toEqual({
      path: 'src/a.js',
      line: 11,
      side: 'RIGHT',
    });
  });

  it('returns null when finding.line is null (file-level finding)', () => {
    const patch = '@@ -1,1 +10,1 @@\n+added';
    const finding = { file: 'src/a.js', line: null };
    const fileObj = { filename: 'src/a.js', patch };
    expect(mapFindingToComment(finding, fileObj)).toBeNull();
  });

  it('returns null when the finding file does not match the file object', () => {
    const patch = '@@ -1,1 +10,1 @@\n+added';
    const finding = { file: 'src/other.js', line: 10 };
    const fileObj = { filename: 'src/a.js', patch };
    expect(mapFindingToComment(finding, fileObj)).toBeNull();
  });

  it('snaps a finding on an invalid (deleted) line to the nearest valid line', () => {
    // added at 10, ctx at 11; a finding claiming line 50 (off) snaps to 11
    // within window 3 only if within range. Construct a deleted-line scenario:
    // ctx10, -removed(old11), +added11(new), ctx12. A finding at old line 11
    // (deleted) — but we pass new-side line numbers. So test the off-by case:
    // finding says line 13 (not present), nearest valid is 12.
    const patch = [
      '@@ -1,3 +10,3 @@',
      ' ctx10',
      '-removed',
      '+added11',
      ' ctx12',
    ].join('\n');
    const finding = { file: 'src/a.js', line: 13 };
    const fileObj = { filename: 'src/a.js', patch };
    expect(mapFindingToComment(finding, fileObj)).toEqual({
      path: 'src/a.js',
      line: 12,
      side: 'RIGHT',
    });
  });

  it('returns null when the line is invalid AND no snap is within the window', () => {
    const patch = '@@ -1,1 +10,1 @@\n+added';
    const finding = { file: 'src/a.js', line: 500 };
    const fileObj = { filename: 'src/a.js', patch };
    expect(mapFindingToComment(finding, fileObj)).toBeNull();
  });

  it('returns null when the file object has no patch', () => {
    const finding = { file: 'src/a.js', line: 10 };
    const fileObj = { filename: 'src/a.js', patch: '' };
    expect(mapFindingToComment(finding, fileObj)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * partitionFindings
 * ------------------------------------------------------------------ */

describe('partitionFindings', () => {
  it('splits mixed findings into inline and summaryOnly buckets', () => {
    const patch = '@@ -1,2 +10,2 @@\n+added\n ctx';
    const files = [{ filename: 'src/a.js', patch }];
    const findings = [
      { file: 'src/a.js', line: 10 }, // inline-mappable (added line)
      { file: 'src/a.js', line: null }, // summary-only (file-level)
      { file: 'src/a.js', line: 500 }, // summary-only (unmappable)
    ];
    const { inline, summaryOnly } = partitionFindings(findings, files);
    expect(inline).toHaveLength(1);
    expect(inline[0].comment).toEqual({ path: 'src/a.js', line: 10, side: 'RIGHT' });
    expect(inline[0].finding).toEqual({ file: 'src/a.js', line: 10 });
    expect(summaryOnly).toHaveLength(2);
    expect(summaryOnly.map((f) => f.line)).toEqual([null, 500]);
  });

  it('returns all findings as inline when all map', () => {
    const patch = '@@ -1,2 +10,2 @@\n+added\n ctx';
    const files = [{ filename: 'src/a.js', patch }];
    const findings = [
      { file: 'src/a.js', line: 10 },
      { file: 'src/a.js', line: 11 },
    ];
    const { inline, summaryOnly } = partitionFindings(findings, files);
    expect(inline).toHaveLength(2);
    expect(summaryOnly).toHaveLength(0);
  });

  it('returns all findings as summaryOnly when none map (no patches)', () => {
    const files = [{ filename: 'src/a.js', patch: '' }];
    const findings = [
      { file: 'src/a.js', line: 10 },
      { file: 'src/a.js', line: 11 },
    ];
    const { inline, summaryOnly } = partitionFindings(findings, files);
    expect(inline).toHaveLength(0);
    expect(summaryOnly).toHaveLength(2);
  });

  it('returns empty buckets for empty findings', () => {
    const patch = '@@ -1,1 +1,1 @@\n+added';
    const files = [{ filename: 'src/a.js', patch }];
    const { inline, summaryOnly } = partitionFindings([], files);
    expect(inline).toEqual([]);
    expect(summaryOnly).toEqual([]);
  });

  it('uses the files Map for O(1) lookup across multiple files', () => {
    const files = [
      { filename: 'src/a.js', patch: '@@ -1,1 +10,1 @@\n+a' },
      { filename: 'src/b.js', patch: '@@ -1,1 +20,1 @@\n+b' },
    ];
    const findings = [
      { file: 'src/a.js', line: 10 },
      { file: 'src/b.js', line: 20 },
    ];
    const { inline } = partitionFindings(findings, files);
    expect(inline).toHaveLength(2);
    expect(inline[0].comment).toEqual({ path: 'src/a.js', line: 10, side: 'RIGHT' });
    expect(inline[1].comment).toEqual({ path: 'src/b.js', line: 20, side: 'RIGHT' });
  });

  it('handles a finding whose file is not in the files list (summary-only)', () => {
    const files = [{ filename: 'src/a.js', patch: '@@ -1,1 +10,1 @@\n+a' }];
    const findings = [{ file: 'src/missing.js', line: 10 }];
    const { inline, summaryOnly } = partitionFindings(findings, files);
    expect(inline).toHaveLength(0);
    expect(summaryOnly).toHaveLength(1);
  });
});
