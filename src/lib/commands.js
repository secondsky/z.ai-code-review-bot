/**
 * `/zai` comment parser + command allowlist.
 *
 * PURE module: no I/O, no async, no imports of actions modules. It reads a
 * single comment body's first line and returns a structured parse result. The
 * router (src/index.js) uses this to decide whether an `issue_comment` is a
 * command and, if so, which handler to dispatch to.
 *
 * Supported prefixes (the fork's aliases), case-insensitive, at the start of
 * the (whitespace-trimmed) first line:
 *   `/zai`, `/zai-bot`, `@zai`, `@zai-bot`
 *
 * Result shape: `{ command, args, raw, error }` where exactly one of
 * `command`/`error` is meaningful per the rules below.
 */

/** The verbs the bot recognises. Order is part of the contract. */
export const ALLOWED_COMMANDS = [
  'ask',
  'review',
  'explain',
  'describe',
  'impact',
  'help',
];

const ALLOWED_SET = new Set(ALLOWED_COMMANDS);

/**
 * Recognised command prefixes (lowercased). The fork accepted both the slash
 * form and the @-mention form, with and without the `-bot` suffix.
 */
const PREFIXES = ['/zai-bot', '/zai', '@zai-bot', '@zai'];

/**
 * Parse a comment body for a `/zai` (or alias) command.
 *
 * Rules (per task-7-brief):
 *  - Only the FIRST line is inspected (`text.split('\n')[0]`).
 *  - Non-string input → `{ command: null, args: null, raw: text, error: 'MALFORMED_INPUT' }`.
 *  - Trim leading whitespace; lowercase for prefix detection.
 *  - If the trimmed text does not start with a recognised prefix →
 *    `{ command: null, args: null, raw: text, error: 'NOT_A_COMMAND' }`.
 *  - Strip the prefix; the first remaining token is `command` (lowercased),
 *    the rest of the line is `args` (trimmed single string; may be `''`).
 *  - Empty `command` → `MALFORMED_INPUT`.
 *  - `command` not in {@link ALLOWED_COMMANDS} → `UNKNOWN_COMMAND` (command
 *    and args still returned).
 *  - Otherwise → success (`error: null`).
 *
 * @param {string} text
 * @returns {{ command: string|null, args: string|null, raw: string, error: string|null }}
 */
export function parseCommand(text) {
  // Defensive: non-string input is a malformed invocation.
  if (typeof text !== 'string') {
    return { command: null, args: null, raw: text, error: 'MALFORMED_INPUT' };
  }

  // CMD-1: normalize line endings before splitting. Handle CRLF (Windows),
  // LFCR (rare), and lone CR (old MacOS) so the "first line" is correct
  // regardless of the client's line-ending convention.
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Only the first line is parsed.
  const firstLine = normalized.split('\n')[0];
  const trimmed = firstLine.trim();
  const lower = trimmed.toLowerCase();

  // Find a recognised prefix at the start. W15-A4-7: the prefix must end at
  // a token boundary — the next character (if any) must be whitespace or the
  // string must end. Without this, '/zai-botask hi' matched '/zai-bot' and
  // parsed as command 'ask' with args 'hi', and '/zaihelp' parsed as 'help',
  // so comments addressed to other tools ("zai-botask") triggered command
  // runs. The longer prefixes are listed first, and the '-bot' suffixes
  // cannot satisfy the boundary for a shorter prefix (the next char would be
  // '-'), so first-match-wins here cannot mis-select an alias.
  const prefix = PREFIXES.find(
    (p) =>
      lower.startsWith(p) &&
      (lower.length === p.length || /\s/.test(lower[p.length])),
  );
  if (!prefix) {
    return { command: null, args: null, raw: text, error: 'NOT_A_COMMAND' };
  }

  // Strip the prefix and any immediately-following whitespace.
  const remainder = trimmed.slice(prefix.length).trim();
  if (remainder === '') {
    return { command: null, args: null, raw: text, error: 'MALFORMED_INPUT' };
  }

  // First token is the command; the rest is args (single trimmed string).
  // Split on ANY whitespace (\s, covers spaces/tabs/multiple spaces), not just
  // a literal ' ', so `/zai\task hi` and `/zai  ask   hi` parse correctly.
  // CMD-1: use `[\s\S]*` (not `.*`) as defense-in-depth so a stray CR in the
  // args cannot truncate the capture (`.` does not match `\r`).
  const match = remainder.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  let command = match ? match[1].toLowerCase() : remainder.toLowerCase();
  let args = match && match[2] ? match[2].trim() : '';

  if (!ALLOWED_SET.has(command)) {
    return { command, args, raw: text, error: 'UNKNOWN_COMMAND' };
  }

  return { command, args, raw: text, error: null };
}
