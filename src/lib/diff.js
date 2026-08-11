/**
 * Unified-diff parsing + finding-to-comment mapping for inline line-level
 * review comments (the v2 headline feature).
 *
 * This module is PURE (no I/O). It reuses {@link parseHunkHeader} from
 * `./scanners/_patch.js` — that helper already parses the `@@ -a,b +c,d @@`
 * header line and returns the new-side start (`c`). The richer walker here
 * emits ALL lines (added + context + deleted) with BOTH old/new line numbers,
 * which the inline-comment mapper needs: GitHub only accepts comments on lines
 * that exist in the new (RIGHT) side of the diff — added OR context, never
 * deleted-only.
 *
 * The four public entry points compose:
 *   parseHunks(patch)             → structured hunks (all line types)
 *   isValidCommentLine(patch, n)  → can GitHub anchor a comment at new-line n?
 *   findNearestValidLine(patch,n) → snap an off-by-one/deleted line to a valid one
 *   mapFindingToComment(f, file)  → {path, line, side:'RIGHT'} or null
 *   partitionFindings(fs, files)  → {inline, summaryOnly} split
 *
 * @module src/lib/diff.js
 */

// Re-export parseHunkHeader so callers can import all diff-parsing helpers
// from this single canonical module. The walker below uses a richer local
// variant (parseFullHunkHeader) that also captures the old-side counts.
export { parseHunkHeader } from './scanners/_patch.js';

/**
 * Parse a full hunk header `@@ -a,b +c,d @@` (or single-line `@@ -a +c @@`)
 * into its four numeric components. Returns null when the line is not a hunk
 * header or carries no `+c` portion.
 *
 * Mirrors {@link parseHunkHeader} but ALSO captures the `-a,b` (old) portion
 * and the counts — the walker below does not strictly need the counts (it
 * derives line numbers from the body), but recording them keeps the hunk
 * metadata faithful to the patch and lets tests assert the parsed shape.
 *
 * @param {string} line
 * @returns {{oldStart:number, oldCount:number, newStart:number, newCount:number} | null}
 */
function parseFullHunkHeader(line) {
  if (typeof line !== 'string' || !line.startsWith('@@')) return null;
  const m = line.match(/-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?/);
  if (!m) return null;
  const oldStart = parseInt(m[1], 10);
  const oldCount = m[2] !== undefined ? parseInt(m[2], 10) : 1;
  const newStart = parseInt(m[3], 10);
  const newCount = m[4] !== undefined ? parseInt(m[4], 10) : 1;
  // newStart must be >= 1 (need at least one new line to comment on), but
  // oldStart may be 0 — git emits `@@ -0,0 +1,N @@` for newly-created files.
  if (!Number.isFinite(oldStart) || oldStart < 0) return null;
  if (!Number.isFinite(newStart) || newStart < 1) return null;
  return { oldStart, oldCount, newStart, newCount };
}

/**
 * Parse a unified-diff patch into structured hunks.
 *
 * Each returned hunk carries the `@@ -a,b +c,d @@` numeric header plus a
 * `lines` array where EVERY body line is typed:
 *   - `{type:'add', newLine, oldLine:null, text}`  — a `+text` addition
 *   - `{type:'del', newLine:null, oldLine, text}`  — a `-text` removal
 *   - `{type:'ctx', newLine, oldLine, text}`       — a ` text` context line
 *
 * Tracking rules (both counters advance through the body):
 *   - `+++`/`---` file headers inside the body are skipped (not real additions
 *     or removals — they only appear at patch scope, but we defend anyway).
 *   - `\ No newline at end of file` is metadata — skipped, counters unchanged.
 *   - A truly empty line is treated as a context line (git emits context as a
 *     leading space, but a bare empty line is also context).
 *
 * For patches with no hunk header (shouldn't happen for real GitHub patches),
 * the walker returns `[]` — body lines without a preceding valid `@@` header
 * are skipped, as their line numbers cannot be reliably determined.
 *
 * @param {string} patch
 * @returns {Array<{oldStart:number, oldCount:number, newStart:number, newCount:number, lines:Array<{type:string, newLine:number|null, oldLine:number|null, text:string}>}>}
 */
export function parseHunks(patch) {
  if (typeof patch !== 'string' || patch.length === 0) return [];

  /** @type {Array<{oldStart:number, oldCount:number, newStart:number, newCount:number, lines:Array}>} */
  const hunks = [];
  let cur = null;
  let oldLine = 1;
  let newLine = 1;

  for (const raw of patch.split('\n')) {
    if (raw.startsWith('@@')) {
      const header = parseFullHunkHeader(raw);
      if (header) {
        oldLine = header.oldStart;
        newLine = header.newStart;
        cur = { ...header, lines: [] };
        hunks.push(cur);
      } else {
        // Reject the hunk header: drop the current hunk context so its body
        // lines are NOT mis-attributed to the prior valid hunk.
        cur = null;
      }
      continue;
    }
    if (!cur) {
      // Lines before the first hunk (diff metadata) are skipped entirely.
      continue;
    }
    if (/^(?:\+\+\+|---)(?:\s|$)/.test(raw)) {
      // File headers — `+++ b/path` or `--- a/path` (space-delimited), or a
      // bare `+++`/`---` at end-of-line. NOT an added/removed line whose
      // content happens to start with `++`/`--` (e.g. `++i;` → `+++i;` has
      // no space after the third `+`). W5-5.
      continue;
    }
    if (raw.startsWith('+')) {
      cur.lines.push({ type: 'add', newLine, oldLine: null, text: raw.slice(1) });
      newLine++;
      continue;
    }
    if (raw.startsWith('-')) {
      cur.lines.push({ type: 'del', newLine: null, oldLine, text: raw.slice(1) });
      oldLine++;
      continue;
    }
    if (raw.startsWith('\\')) {
      // "\ No newline at end of file" — metadata, counters unchanged.
      continue;
    }
    // Context line (leading space stripped; bare empty line also context).
    const text = raw.startsWith(' ') ? raw.slice(1) : raw;
    cur.lines.push({ type: 'ctx', newLine, oldLine, text });
    oldLine++;
    newLine++;
  }

  return hunks;
}

/**
 * Collect the set of new-side line numbers that GitHub will accept an inline
 * comment on (added OR context lines — anything with a non-null `newLine`).
 *
 * @param {string} patch
 * @returns {Set<number>}
 */
function collectValidLines(patch) {
  const valid = new Set();
  for (const hunk of parseHunks(patch)) {
    for (const entry of hunk.lines) {
      if (entry.newLine !== null) valid.add(entry.newLine);
    }
  }
  return valid;
}

/**
 * Can a GitHub inline review comment anchor to this new-side line number?
 *
 * GitHub accepts comments on added lines AND context lines (lines present in
 * the new version), but NOT on removed-only lines (they have no new-side line
 * number at all). This walks the patch once and returns true if `line` matches
 * an `add` or `ctx` entry's `newLine`.
 *
 * @param {string} patch
 * @param {number} line - new-side line number
 * @returns {boolean}
 */
export function isValidCommentLine(patch, line) {
  if (typeof patch !== 'string' || patch.length === 0) return false;
  if (!Number.isInteger(line) || line < 1) return false;
  return collectValidLines(patch).has(line);
}

/**
 * If the finding's line is slightly off (a deleted line, or an off-by-one),
 * snap to the nearest valid (add/ctx) new-side line within a small window.
 *
 * Search strategy: iterate distances 1..window, checking `line - dist` (above)
 * and `line + dist` (below). At equal distance, ADDED lines are preferred over
 * context lines (an addition is the more likely anchor for a finding about new
 * code). Returns the first valid hit, the line itself if it's already valid,
 * or null if nothing is within the window.
 *
 * @param {string} patch
 * @param {number} line
 * @param {number} [window=3] - max distance to search
 * @returns {number | null}
 */
export function findNearestValidLine(patch, line, window = 3) {
  if (typeof patch !== 'string' || patch.length === 0) return null;
  if (!Number.isInteger(line) || line < 1) return null;
  const w = Number.isInteger(window) && window >= 0 ? window : 3;

  // Build a line→type map so we can prefer 'add' over 'ctx' at equal distance.
  /** @type {Map<number, 'add'|'ctx'>} */
  const lineType = new Map();
  for (const hunk of parseHunks(patch)) {
    for (const entry of hunk.lines) {
      if (entry.newLine !== null) {
        // 'add' wins over 'ctx' if both somehow map to the same newLine.
        if (!lineType.has(entry.newLine) || entry.type === 'add') {
          lineType.set(entry.newLine, entry.type);
        }
      }
    }
  }

  // Exact match first (the common case — no snap needed).
  if (lineType.has(line)) return line;

  for (let dist = 1; dist <= w; dist++) {
    // At each distance, prefer 'add' over 'ctx' when both sides are present.
    const above = line - dist;
    const below = line + dist;
    const aboveType = lineType.has(above) ? lineType.get(above) : null;
    const belowType = lineType.has(below) ? lineType.get(below) : null;

    if (aboveType === 'add' && belowType === 'add') {
      // Both adds at equal distance — prefer the one closer to the original
      // intent. The above (smaller line number) is as good a tie-breaker as
      // any; pick it deterministically.
      return above;
    }
    if (aboveType === 'add') return above;
    if (belowType === 'add') return below;
    // Neither is an add; fall back to whichever ctx exists.
    if (aboveType === 'ctx') return above;
    if (belowType === 'ctx') return below;
  }
  return null;
}

/**
 * Map a finding to a GitHub review-comment coordinate, or null if unmappable.
 *
 * Rules (in order):
 *   1. `finding.line` null → null (file-level finding, goes to summary).
 *   2. `finding.file !== file.filename` → null (defensive; shouldn't happen).
 *   3. `isValidCommentLine(patch, line)` → `{path, line, side:'RIGHT'}`.
 *   4. Else try `findNearestValidLine`; if found, return with the snapped line.
 *   5. Else null.
 *
 * @param {{file:string, line:number|null}} finding
 * @param {{filename:string, patch:string}} file
 * @returns {{path:string, line:number, side:'RIGHT'} | null}
 */
export function mapFindingToComment(finding, file) {
  if (!finding || !file) return null;
  if (finding.line === null || finding.line === undefined) return null;
  if (finding.file !== file.filename) return null;
  if (typeof file.patch !== 'string' || file.patch.length === 0) return null;

  const target = finding.line;
  if (!Number.isInteger(target) || target < 1) return null;

  if (isValidCommentLine(file.patch, target)) {
    return { path: file.filename, line: target, side: 'RIGHT' };
  }
  const snapped = findNearestValidLine(file.patch, target);
  if (snapped !== null) {
    return { path: file.filename, line: snapped, side: 'RIGHT' };
  }
  return null;
}

/**
 * Partition findings into inline-mappable and summary-only buckets.
 *
 * Builds a `Map<filename, file>` for O(1) lookup, then for each finding
 * attempts `mapFindingToComment`. Non-null results go to `inline` (carrying
 * the resolved comment coordinate); the rest go to `summaryOnly`.
 *
 * @param {Array} findings
 * @param {Array<{filename:string, patch:string}>} files
 * @returns {{inline: Array<{finding:object, comment:{path:string, line:number, side:'RIGHT'}}>, summaryOnly: Array<object>}}
 */
export function partitionFindings(findings, files) {
  const fileMap = new Map();
  if (Array.isArray(files)) {
    for (const f of files) {
      if (f && typeof f.filename === 'string') fileMap.set(f.filename, f);
    }
  }
  const inline = [];
  const summaryOnly = [];
  if (!Array.isArray(findings)) return { inline, summaryOnly };

  for (const finding of findings) {
    const fileObj = finding && typeof finding.file === 'string' ? fileMap.get(finding.file) : null;
    const comment = fileObj ? mapFindingToComment(finding, fileObj) : null;
    if (comment) {
      inline.push({ finding, comment });
    } else {
      summaryOnly.push(finding);
    }
  }
  return { inline, summaryOnly };
}
