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

  // Only the first line is parsed.
  const firstLine = text.split('\n')[0];
  const trimmed = firstLine.trim();
  const lower = trimmed.toLowerCase();

  // Find a recognised prefix at the start.
  const prefix = PREFIXES.find((p) => lower.startsWith(p));
  if (!prefix) {
    return { command: null, args: null, raw: text, error: 'NOT_A_COMMAND' };
  }

  // Strip the prefix and any immediately-following whitespace.
  const remainder = trimmed.slice(prefix.length).trim();
  if (remainder === '') {
    return { command: null, args: null, raw: text, error: 'MALFORMED_INPUT' };
  }

  // First token is the command; the rest is args (single trimmed string).
  const sp = remainder.indexOf(' ');
  let command;
  let args;
  if (sp === -1) {
    command = remainder;
    args = '';
  } else {
    command = remainder.slice(0, sp);
    args = remainder.slice(sp + 1).trim();
  }
  command = command.toLowerCase();

  if (!ALLOWED_SET.has(command)) {
    return { command, args, raw: text, error: 'UNKNOWN_COMMAND' };
  }

  return { command, args, raw: text, error: null };
}
