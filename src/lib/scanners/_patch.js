/**
 * Shared unified-diff parsing helpers used by both the secrets and patterns
 * scanners. Pure (no I/O) — fully unit-testable.
 *
 * The two scanners need to enumerate ADDED lines (those starting with `+`,
 * excluding the `+++` file header) AND know their absolute (new) line number
 * in the post-patch file. `parseAddedLines` does exactly that, walking the
 * `@@ -a,b +c,d @@` hunk headers to track the running line count.
 *
 * @module src/lib/scanners/_patch.js
 */

/**
 * Parse a `@@ -a,b +c,d @@ optional_section_header` line and return the new-
 * file starting line (`c`). Returns null on a non-matching line.
 *
 * @param {string} line
 * @returns {number | null}
 */
export function parseHunkHeader(line) {
  if (typeof line !== 'string' || !line.startsWith('@@')) return null;
  // Capture the +c,d portion. Be tolerant of `,d` being absent (single-line hunks).
  const m = line.match(/\+(\d+)(?:,(\d+))?/);
  if (!m) return null;
  const start = parseInt(m[1], 10);
  return Number.isFinite(start) && start >= 1 ? start : null;
}

/**
 * Enumerate the ADDED lines in a unified-diff patch along with their absolute
 * line numbers in the new (post-patch) file.
 *
 * Returns an array of `{ line, text }` where:
 *   - `line` is the 1-based absolute line number in the new file
 *   - `text` is the added-line CONTENT (the leading `+` stripped)
 *
 * Walks the patch line-by-line, tracking the current new-file line counter:
 *   - Hunk header `@@ -a,b +c,d @@` resets the counter to `c`.
 *   - A line starting with `+` (and not `+++`) is an addition; emit it and
 *     increment the counter.
 *   - A line starting with `-` (and not `---`) is a removal; counter unchanged.
 *   - A line starting with `\` (e.g. `\ No newline at end of file`) is metadata;
 *     counter unchanged.
 *   - Any other line (context, or before the first hunk) is context; emit
 *     nothing but still increment the counter if we're inside a hunk.
 *
 * For patches with no hunk header, the line counter starts at 1 (best-effort —
 * real GitHub patches always include a hunk header).
 *
 * @param {string} patch
 * @returns {Array<{ line: number, text: string }>}
 */
export function parseAddedLines(patch) {
  if (typeof patch !== 'string' || patch.length === 0) return [];
  const out = [];
  let newLine = 1; // updated by hunk header
  let inHunk = false;
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('@@')) {
      const start = parseHunkHeader(raw);
      if (start !== null) {
        newLine = start;
        inHunk = true;
      }
      continue;
    }
    if (!inHunk) {
      // Lines before the first hunk (e.g. diff metadata) are skipped entirely.
      continue;
    }
    if (raw.startsWith('+++')) {
      // File header — not an addition. Skip.
      continue;
    }
    if (raw.startsWith('+')) {
      out.push({ line: newLine, text: raw.slice(1) });
      newLine++;
      continue;
    }
    if (raw.startsWith('---')) {
      continue;
    }
    if (raw.startsWith('-')) {
      // Removal — counter unchanged.
      continue;
    }
    if (raw.startsWith('\\')) {
      // "\ No newline at end of file" — metadata, counter unchanged.
      continue;
    }
    // Context line.
    newLine++;
  }
  return out;
}
