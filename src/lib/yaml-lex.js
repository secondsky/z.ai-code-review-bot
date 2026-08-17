/**
 * Shared YAML lexical helpers.
 *
 * The hand-rolled YAML subset parsers in `./repo-config.js` (`.zai.yml`) and
 * `./learnings.js` (`.zai/learnings.yml`) use the same comment-strip + unquote
 * idioms. They had DRIFTED: only the learnings copy carried the W15-A6-6
 * double-quote word-glue guard, so a trailing comment after a value like
 * `use 5" floppy` survived into the parsed `.zai.yml` value. This module is
 * the single hardened home for those idioms (bodies verbatim from the
 * learnings.js copy, the authoritative one); both parsers import from here so
 * the dialects can never drift again.
 *
 * @module src/lib/yaml-lex.js
 */

/**
 * Strip a YAML `# ...` comment from a line, UNLESS the `#` is inside a
 * single- or double-quoted string. Shared by `parseZaiYml` in repo-config.js
 * and the learnings parser in learnings.js so the dialect matches.
 *
 * @param {string} line
 * @returns {string}
 */
export function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) {
      // W8-4: only treat `'` as a quote toggle when NOT embedded in a word.
      // An apostrophe glued to a letter/digit (like in `don't` or `it's`)
      // is not a delimiter; treating it as one flips inSingle permanently and
      // disables comment stripping for the rest of the line.
      // W12-4b: the guard must NOT apply when already inside a single-quoted
      // string — a `'` inside is always the closing delimiter.
      if (inSingle) {
        inSingle = false;
      } else {
        const prev = i > 0 ? line[i - 1] : '';
        if (!/[A-Za-z0-9]/.test(prev)) {
          inSingle = !inSingle;
        }
      }
    } else if (ch === '"' && !inSingle) {
      // W15-A6-6: mirror the W8-4 apostrophe guard for `"` — a double quote
      // glued to a word character (like the inches mark in `5" floppy`) is
      // not a delimiter; treating it as one flips inDouble permanently and
      // disables comment stripping for the rest of the line (the trailing
      // `# comment` then survives into the parsed value). As with W8-4, the
      // guard must NOT apply when already inside a double-quoted string — a
      // `"` inside is always the closing delimiter (values legitimately end
      // in word characters, e.g. `"x # not comment"`).
      if (inDouble) {
        inDouble = false;
      } else {
        const prev = i > 0 ? line[i - 1] : '';
        if (!/[A-Za-z0-9]/.test(prev)) {
          inDouble = !inDouble;
        }
      }
    } else if (ch === '#' && !inSingle && !inDouble) {
      // A `#` only starts a comment when it's at the start of the line or
      // preceded by whitespace. `value#frag` is NOT a comment.
      const prev = i > 0 ? line[i - 1] : '';
      if (i === 0 || /\s/.test(prev)) {
        return line.slice(0, i);
      }
    }
  }
  return line;
}

/**
 * Unquote a YAML scalar value: strips matching surrounding single or double
 * quotes. Returns the input unchanged when not quoted.
 *
 * @param {string} v
 * @returns {string}
 */
export function unquote(v) {
  if (typeof v !== 'string' || v.length < 2) return v;
  if (
    (v[0] === '"' && v[v.length - 1] === '"') ||
    (v[0] === "'" && v[v.length - 1] === "'")
  ) {
    return v.slice(1, -1);
  }
  return v;
}
