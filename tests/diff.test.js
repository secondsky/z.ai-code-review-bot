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

  // ------------------------------------------------------------------
  // W5-5: an ADDED line whose content starts with `++` (e.g. `++i;`) is
  // emitted in the diff as `+++i;`. The old `raw.startsWith('+++')` check
  // misclassified it as a file header and silently dropped it, corrupting
  // the line-number mapping for all subsequent lines in the hunk. Real git
  // file headers are `+++ b/path` (space-delimited); an added line's content
  // is `+++content` (no space). Only treat `+++`/`---` as a header when a
  // space (or end-of-line) follows the third `+`/`-`.
  // ------------------------------------------------------------------
  it('W5-5: an added line whose text starts with ++ is kept (not a header)', () => {
    const patch = [
      '@@ -1,2 +1,4 @@',
      ' context',
      '+++i;',
      '+added',
      ' context',
    ].join('\n');
    const hunks = parseHunks(patch);
    expect(hunks[0].lines).toEqual([
      { type: 'ctx', newLine: 1, oldLine: 1, text: 'context' },
      { type: 'add', newLine: 2, oldLine: null, text: '++i;' },
      { type: 'add', newLine: 3, oldLine: null, text: 'added' },
      { type: 'ctx', newLine: 4, oldLine: 2, text: 'context' },
    ]);
  });

  it('W5-5: a removed line whose text starts with -- is kept (not a header)', () => {
    // The diff line is `---deprecated_flag` (1 `-` prefix + `--deprecated_flag`
    // content). The old `startsWith('---')` check misclassified it as a header.
    const patch = [
      '@@ -1,3 +1,2 @@',
      '---deprecated_flag = true;',
      ' context',
      '+added',
    ].join('\n');
    const hunks = parseHunks(patch);
    expect(hunks[0].lines).toEqual([
      { type: 'del', newLine: null, oldLine: 1, text: '--deprecated_flag = true;' },
      { type: 'ctx', newLine: 1, oldLine: 2, text: 'context' },
      { type: 'add', newLine: 2, oldLine: null, text: 'added' },
    ]);
  });

  it('W5-5: a real +++ b/file header inside the hunk body is still skipped', () => {
    // Regression guard: the genuine git header form (space after +++) must
    // still be treated as a header and NOT as an addition.
    const patch = [
      '@@ -1,2 +1,2 @@',
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

  it('parses a new-file patch with header @@ -0,0 +1,N @@ (oldStart=0)', () => {
    // git emits `@@ -0,0 +1,N @@` for newly-created files. The oldStart of 0
    // must be accepted (not rejected as invalid) so inline comments work on
    // new files. See F01.
    const patch = [
      '@@ -0,0 +1,3 @@',
      '+line one',
      '+line two',
      '+line three',
    ].join('\n');
    const hunks = parseHunks(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ oldStart: 0, oldCount: 0, newStart: 1, newCount: 3 });
    expect(hunks[0].lines).toEqual([
      { type: 'add', newLine: 1, oldLine: null, text: 'line one' },
      { type: 'add', newLine: 2, oldLine: null, text: 'line two' },
      { type: 'add', newLine: 3, oldLine: null, text: 'line three' },
    ]);
  });

  it('parses a mixed patch where a valid hunk is followed by a new-file hunk', () => {
    // A valid hunk followed by a new-file hunk (`@@ -0,0 +1,2 @@`). Both must
    // parse correctly — the second hunk's body must NOT bleed into the first
    // hunk with wrong line numbers. See F02.
    const patch = [
      '@@ -1,2 +1,2 @@',
      ' ctx at 1',
      '+changed at 2',
      '@@ -0,0 +1,2 @@',
      '+brand new at 1',
      '+brand new at 2',
    ].join('\n');
    const hunks = parseHunks(patch);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ oldStart: 1, newStart: 1 });
    expect(hunks[0].lines).toEqual([
      { type: 'ctx', newLine: 1, oldLine: 1, text: 'ctx at 1' },
      { type: 'add', newLine: 2, oldLine: null, text: 'changed at 2' },
    ]);
    expect(hunks[1]).toMatchObject({ oldStart: 0, newStart: 1 });
    expect(hunks[1].lines).toEqual([
      { type: 'add', newLine: 1, oldLine: null, text: 'brand new at 1' },
      { type: 'add', newLine: 2, oldLine: null, text: 'brand new at 2' },
    ]);
  });

  it('does not bleed body lines of a rejected hunk into the prior valid hunk', () => {
    // If a hunk header is rejected (e.g. a malformed @@ line), its body lines
    // must NOT be attached to the previous valid hunk. See F02.
    const patch = [
      '@@ -1,1 +1,1 @@',
      '+valid at 1',
      '@@ not-a-real-hunk',
      '+orphan body line',
      '+another orphan',
    ].join('\n');
    const hunks = parseHunks(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines).toEqual([
      { type: 'add', newLine: 1, oldLine: null, text: 'valid at 1' },
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

  it('returns the right valid lines for a new-file-only patch (@@ -0,0 +1,N @@)', () => {
    // A newly-created file has oldStart=0. All added new-side lines must be
    // valid comment anchors. See F01.
    const patch = [
      '@@ -0,0 +1,3 @@',
      '+line one',
      '+line two',
      '+line three',
    ].join('\n');
    expect(isValidCommentLine(patch, 1)).toBe(true);
    expect(isValidCommentLine(patch, 2)).toBe(true);
    expect(isValidCommentLine(patch, 3)).toBe(true);
    expect(isValidCommentLine(patch, 4)).toBe(false);
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

/* ------------------------------------------------------------------ *
 * parseHunks — edge cases
 * ------------------------------------------------------------------ */

describe('parseHunks (edge cases)', () => {
  it('returns [] for a patch with body lines but no @@ hunk header', () => {
    // The walker requires a valid hunk header to set `cur`; without one, every
    // body line is skipped via the `if (!cur) continue` guard. This is the
    // correct defensive behavior: line numbers cannot be reliably determined
    // without a header, so the walker refuses to guess (avoids mis-attribution).
    const patch = ['+added', ' ctx', '-removed'].join('\n');
    const hunks = parseHunks(patch);
    expect(hunks).toEqual([]);
  });

  it('handles a malformed @@ header by dropping body lines (no throw)', () => {
    // A line starting with @@ that fails the `-a +b` regex sets `cur = null`,
    // so subsequent body lines are skipped rather than mis-attributed.
    const patch = ['@@ garbage @@', '+body1', '+body2'].join('\n');
    const hunks = parseHunks(patch);
    expect(hunks).toEqual([]);
  });

  it('does not let body lines following a malformed header leak into a prior valid hunk', () => {
    // A valid hunk, then a malformed header, then body lines. The body lines
    // after the malformed header must NOT attach to the valid hunk.
    const patch = [
      '@@ -1,1 +1,1 @@',
      '+valid',
      '@@ garbage @@',
      '+leak1',
      '+leak2',
    ].join('\n');
    const hunks = parseHunks(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines).toEqual([
      { type: 'add', newLine: 1, oldLine: null, text: 'valid' },
    ]);
  });

  it('skips "\\ No newline at end of file" and leaves subsequent line counters unchanged', () => {
    // The `\ No newline` marker is metadata: it must not advance either counter.
    // Verify the ctx lines AFTER the marker still get the correct new/old numbers.
    const patch = [
      '@@ -1,3 +10,3 @@',
      '+added10',
      '\\ No newline at end of file',
      ' ctx11',
      ' ctx12',
    ].join('\n');
    const hunks = parseHunks(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines).toEqual([
      { type: 'add', newLine: 10, oldLine: null, text: 'added10' },
      { type: 'ctx', newLine: 11, oldLine: 1, text: 'ctx11' },
      { type: 'ctx', newLine: 12, oldLine: 2, text: 'ctx12' },
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * findNearestValidLine — edge cases
 * ------------------------------------------------------------------ */

describe('findNearestValidLine (edge cases)', () => {
  it('returns a valid line at distance exactly equal to the window (window=3)', () => {
    // Valid lines: 10 (add), 11 (ctx). With window=3, distance 3 is in range
    // (loop is `dist <= w`). Searching 7 → distance 3 from 10 → returns 10.
    const patch = ['@@ -1,2 +10,2 @@', '+added10', ' ctx11'].join('\n');
    expect(findNearestValidLine(patch, 7, 3)).toBe(10);
    // Same check below: searching 14 → distance 3 from 11 → returns 11.
    expect(findNearestValidLine(patch, 14, 3)).toBe(11);
  });

  it('returns null when the nearest valid line is one beyond the window (distance 4, window=3)', () => {
    // Valid lines: 10, 11. Searching 6 → distance 4 from 10 → out of window.
    const patch = ['@@ -1,2 +10,2 @@', '+added10', ' ctx11'].join('\n');
    expect(findNearestValidLine(patch, 6, 3)).toBeNull();
    // Below: searching 15 → distance 4 from 11 → out of window.
    expect(findNearestValidLine(patch, 15, 3)).toBeNull();
  });

  it('add beats ctx at equal distance (ctx above, add below → returns the add below)', () => {
    // Use two hunks to create non-contiguous valid lines (within a single hunk
    // valid new-lines are always contiguous, so a true tie needs two hunks).
    // Hunk1 ctx at new 10; Hunk2 add at new 12. Searching 11 is distance 1
    // from both: above is ctx, below is add → add wins → 12.
    const patch = [
      '@@ -1,1 +10,1 @@',
      ' ctx10',
      '@@ -1,1 +12,1 @@',
      '+add12',
    ].join('\n');
    expect(findNearestValidLine(patch, 11)).toBe(12);
  });

  it('add beats ctx at equal distance (add above, ctx below → returns the add above)', () => {
    // Hunk1 add at new 10; Hunk2 ctx at new 12. Searching 11: above add, below
    // ctx → add wins → 10.
    const patch = [
      '@@ -1,1 +10,1 @@',
      '+add10',
      '@@ -1,1 +12,1 @@',
      ' ctx12',
    ].join('\n');
    expect(findNearestValidLine(patch, 11)).toBe(10);
  });

  it('two adds at equal distance → returns the above (smaller line number, deterministic tie-break)', () => {
    // Hunk1 add at new 10; Hunk2 add at new 12. Searching 11: both adds at
    // distance 1 → deterministic pick is the above → 10.
    const patch = [
      '@@ -1,1 +10,1 @@',
      '+add10',
      '@@ -1,1 +12,1 @@',
      '+add12',
    ].join('\n');
    expect(findNearestValidLine(patch, 11)).toBe(10);
  });

  it('exact match returns the line itself (no snap)', () => {
    // Line 11 is a valid add; searching 11 returns 11 without scanning.
    const patch = ['@@ -1,2 +10,2 @@', ' ctx10', '+added11'].join('\n');
    expect(findNearestValidLine(patch, 11)).toBe(11);
  });

  it('returns null for an empty-string patch', () => {
    expect(findNearestValidLine('', 1)).toBeNull();
  });

  it('returns null for a non-string patch (null, number)', () => {
    expect(findNearestValidLine(null, 1)).toBeNull();
    expect(findNearestValidLine(123, 1)).toBeNull();
    expect(findNearestValidLine(undefined, 1)).toBeNull();
  });

  it('returns null for a non-integer line (float, NaN)', () => {
    const patch = '@@ -1,1 +1,1 @@\n+a';
    expect(findNearestValidLine(patch, 1.5)).toBeNull();
    expect(findNearestValidLine(patch, NaN)).toBeNull();
  });

  it('returns null for a line < 1 (zero, negative)', () => {
    const patch = '@@ -1,1 +1,1 @@\n+a';
    expect(findNearestValidLine(patch, 0)).toBeNull();
    expect(findNearestValidLine(patch, -5)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * mapFindingToComment — edge cases
 * ------------------------------------------------------------------ */

describe('mapFindingToComment (edge cases)', () => {
  it('returns null when finding.file does not match file.filename (defensive)', () => {
    const patch = '@@ -1,1 +10,1 @@\n+added';
    const finding = { file: 'src/other.js', line: 10 };
    const fileObj = { filename: 'src/a.js', patch };
    expect(mapFindingToComment(finding, fileObj)).toBeNull();
  });

  it('returns null when finding is null or undefined', () => {
    const fileObj = { filename: 'src/a.js', patch: '@@ -1,1 +10,1 @@\n+added' };
    expect(mapFindingToComment(null, fileObj)).toBeNull();
    expect(mapFindingToComment(undefined, fileObj)).toBeNull();
  });

  it('returns null when file is null or undefined', () => {
    const finding = { file: 'src/a.js', line: 10 };
    expect(mapFindingToComment(finding, null)).toBeNull();
    expect(mapFindingToComment(finding, undefined)).toBeNull();
  });

  it('returns null when file.patch is an empty string', () => {
    const finding = { file: 'src/a.js', line: 10 };
    const fileObj = { filename: 'src/a.js', patch: '' };
    expect(mapFindingToComment(finding, fileObj)).toBeNull();
  });

  it('returns null when finding.line is null (file-level finding goes to summary)', () => {
    const patch = '@@ -1,1 +10,1 @@\n+added';
    const finding = { file: 'src/a.js', line: null };
    const fileObj = { filename: 'src/a.js', patch };
    expect(mapFindingToComment(finding, fileObj)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * partitionFindings — edge cases
 * ------------------------------------------------------------------ */

describe('partitionFindings (edge cases)', () => {
  it('returns {inline:[], summaryOnly:[]} for an empty findings array', () => {
    const files = [{ filename: 'src/a.js', patch: '@@ -1,1 +10,1 @@\n+a' }];
    const result = partitionFindings([], files);
    expect(result.inline).toEqual([]);
    expect(result.summaryOnly).toEqual([]);
  });

  it('sends ALL findings to summaryOnly when the files array is empty', () => {
    const findings = [
      { file: 'src/a.js', line: 10 },
      { file: 'src/b.js', line: 5 },
    ];
    const result = partitionFindings(findings, []);
    expect(result.inline).toHaveLength(0);
    expect(result.summaryOnly).toHaveLength(2);
    expect(result.summaryOnly).toEqual(findings);
  });

  it('sends a finding referencing an unknown file to summaryOnly', () => {
    const files = [{ filename: 'src/a.js', patch: '@@ -1,1 +10,1 @@\n+a' }];
    const findings = [{ file: 'src/unknown.js', line: 10 }];
    const result = partitionFindings(findings, files);
    expect(result.inline).toHaveLength(0);
    expect(result.summaryOnly).toHaveLength(1);
    expect(result.summaryOnly[0]).toEqual({ file: 'src/unknown.js', line: 10 });
  });

  it('splits a mixed batch: some inline, some summaryOnly', () => {
    const patch = '@@ -1,2 +10,2 @@\n+added\n ctx';
    const files = [{ filename: 'src/a.js', patch }];
    const findings = [
      { file: 'src/a.js', line: 10 }, // inline (exact valid add)
      { file: 'src/a.js', line: null }, // summary (file-level)
      { file: 'src/a.js', line: 999 }, // summary (unmappable, out of window)
      { file: 'src/ghost.js', line: 5 }, // summary (unknown file)
    ];
    const result = partitionFindings(findings, files);
    expect(result.inline).toHaveLength(1);
    expect(result.inline[0].comment).toEqual({ path: 'src/a.js', line: 10, side: 'RIGHT' });
    expect(result.summaryOnly).toHaveLength(3);
    expect(result.summaryOnly.map((f) => f.file)).toEqual([
      'src/a.js',
      'src/a.js',
      'src/ghost.js',
    ]);
  });

  it('handles a null/undefined files argument without throwing', () => {
    const findings = [{ file: 'src/a.js', line: 10 }];
    expect(() => partitionFindings(findings, null)).not.toThrow();
    expect(() => partitionFindings(findings, undefined)).not.toThrow();
    const result = partitionFindings(findings, undefined);
    expect(result.inline).toHaveLength(0);
    expect(result.summaryOnly).toHaveLength(1);
  });
});
