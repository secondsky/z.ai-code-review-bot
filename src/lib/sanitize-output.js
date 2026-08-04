/**
 * Conservative model-output sanitizer.
 *
 * The model's raw response becomes a GitHub comment body verbatim today. That
 * gives an attacker who can plant indirect prompt-injection in a PR diff
 * (auto-review path is unauthenticated and runs on fork PRs) the ability to
 * coax the bot — posting under its trusted "Z.ai Code Review" identity — into
 * emitting abusive content. This module is the primary abuse control between
 * `callApi(...)` and the GitHub `createComment`/`updateComment` calls.
 *
 * SCOPE (Conservative — chosen to minimize review-fidelity impact):
 *   1. Length cap. Truncates absurdly long model output (cost/UX, not security).
 *   2. Neutralize `@mentions`. Breaks the GitHub mention trigger so injected
 *      `@everyone` / `@org/team` / arbitrary-user notification spam is dead,
 *      while keeping the text readable (zero-width space after the @). Skipped
 *      inside inline code and fenced code blocks (legit reviews cite code).
 *   3. Neutralize GitHub alert banners (`> [!WARNING]` etc.). A forged official
 *      callout is the single most convincing social-engineering primitive; we
 *      rewrite the line so GitHub no longer renders the banner.
 *
 * EXPLICIT NON-GOALS (documented so reviewers don't "fix" them and mangle
 * legitimate reviews):
 *   - We do NOT strip or rewrite links/images/code/raw-HTML. Real reviews cite
 *     links and code; aggressive link/image stripping was rejected as too costly
 *     to review fidelity. The prompt-hardening layer (UNTRUSTED_PREAMBLE) is the
 *     primary control against phishing-link injection; this sanitizer is the
 *     backstop for the highest-leverage abuse (mentions + alert forgery).
 *
 * All functions are PURE (string in, string out) for unit-testability.
 *
 * @module src/lib/sanitize-output.js
 */

/** Hard cap on posted model output length (chars). */
export const MAX_OUTPUT_CHARS = 16000;

/** Marker appended on truncation. */
const TRUNCATION_MARKER = '\n\n> …(output truncated by Z.ai safety filter)';

/**
 * GitHub alert types that render as official callout banners. Matching is
 * case-insensitive (GitHub accepts any casing).
 */
const ALERT_TYPES = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'];
const ALERT_RE = new RegExp(
  // An optional blockquote prefix, then the [!TYPE] marker at line start.
  // We anchor on start-of-line so a quoted `[!NOTE]` mid-paragraph is unaffected.
  String.raw`(^|\n)(\s*>\s*)\[!(${ALERT_TYPES.join('|')})\]`,
  'gi',
);

/**
 * Escape regex metacharacters in a string (used to build dynamic patterns).
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace @mentions OUTSIDE of code spans. Returns the (possibly) modified text.
 *
 * Strategy: walk the text once, tracking whether we're inside an inline-code
 * span (`...`) or a fenced block (```...```). Replace the `@` of a mention with
 * `@\u200b` (zero-width space) only when NOT in a code region. The zero-width
 * space breaks GitHub's mention parser while leaving the text visually intact.
 *
 * Mention shape (GitHub): `@` followed by a username/login OR `org/team`.
 *   - login:      @[\w-]+               (alphanumerics, underscore, hyphen)
 *   - org/team:   @[\w-]+/[\w-]+        (one slash)
 * We require a non-word boundary before the `@` (so `foo@bar` emails, and
 * identifiers like `array@head`, are not treated as mentions).
 */
const MENTION_RE = /(^|[^\w`\\/])@([A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9_\s-]+)?)/g;

function neutralizeMentionsOutsideCode(text) {
  const lines = text.split('\n');
  let inFence = false; // ``` fence state, tracked across lines
  const out = [];
  for (const line of lines) {
    // Toggle fence state if the line opens/closes a ``` block.
    // A fenced block starts/ends with a line whose trimmed content begins with
    // ``` (optionally with a language tag or indentation). We count opening vs
    // closing delimiters naively: if a line has ``` and we're not in a fence,
    // enter; if we are in a fence and the line is a closing ```, exit.
    if (/^\s*```/.test(line)) {
      if (inFence) {
        inFence = false;
        out.push(line);
        continue;
      }
      inFence = true;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line); // inside fence: never touch
      continue;
    }
    out.push(neutralizeMentionsInLine(line));
  }
  return out.join('\n');
}

/**
 * Neutralize @mentions in a single (non-fenced) line, skipping inline-code
 * spans. We split the line on backtick spans and only run the mention regex on
 * the non-code segments.
 */
function neutralizeMentionsInLine(line) {
  // Split into [code, non-code, code, non-code, ...] segments. Odd indices
  // (after a backtick pair) are inline code; even indices are prose.
  const segments = line.split(/(`[^`]*`)/g);
  return segments
    .map((seg, i) => {
      // Inline code segments start and end with a backtick.
      if (i % 2 === 1) return seg;
      return seg.replace(MENTION_RE, (full, pre, name) => {
        return `${pre}@\u200b${name}`;
      });
    })
    .join('');
}

/**
 * Neutralize GitHub alert-banner syntax. Rewrites `> [!WARNING]` (case-
 * insensitive, optional blockquote) so the leading `[` is dropped; GitHub then
 * renders it as plain quoted text instead of the official callout banner.
 */
function neutralizeAlerts(text) {
  return text.replace(ALERT_RE, (full, boundary, quotePrefix, type) => {
    // Drop the `[` so the line reads `> !WARNING` — no longer a banner marker.
    // Normalize the type to uppercase for consistent output regardless of the
    // casing GitHub accepted on input.
    return `${boundary}${quotePrefix}!${type.toUpperCase()}`;
  });
}

/**
 * Sanitize model output before it is posted as a GitHub comment.
 *
 * Conservative: length-cap, neutralize @mentions (outside code), neutralize
 * GitHub alert banners. Idempotent: applying twice yields the same output.
 *
 * @param {string} text
 * @param {{maxChars?: number}} [options]
 * @returns {string}
 */
export function sanitizeModelOutput(text, options = {}) {
  const maxChars =
    typeof options.maxChars === 'number' && options.maxChars > 0
      ? options.maxChars
      : MAX_OUTPUT_CHARS;

  if (typeof text !== 'string') return '';
  if (text === '') return '';

  // 1. Neutralize mentions + alerts BEFORE truncating, so a long payload of
  //    spam can't escape the sanitizer via truncation timing.
  let out = neutralizeMentionsOutsideCode(text);
  out = neutralizeAlerts(out);

  // 2. Length cap. Compare on the post-sanitization length.
  if (out.length > maxChars) {
    out = out.slice(0, maxChars) + TRUNCATION_MARKER;
  }

  return out;
}

/**
 * Sanitize the `content` portion of an assembled comment body, preserving a
 * leading `## Title` header and a trailing hidden HTML marker comment if
 * present. Used by `buildCommentBody` (comments.js) on the auto-review path so
 * the sanitization never disturbs the marker used for idempotent upsert.
 *
 * If the body has no recognizable header/marker (e.g. a command reply), the
 * entire body is treated as content.
 *
 * @param {string} body
 * @returns {string}
 */
export function sanitizeCommentBody(body) {
  if (typeof body !== 'string' || body === '') return '';
  // Match the shape produced by buildCommentBody: optional "## Title\n\n" head,
  // content, "\n\n<!-- marker -->" tail. We split on the marker first.
  const markerMatch = body.match(/(\n\n<!-- .* -->)$/);
  let prefix = '';
  let content = body;
  let suffix = '';
  if (markerMatch) {
    suffix = markerMatch[1];
    content = body.slice(0, markerMatch.index);
  }
  // Peel a leading "## Title\n\n" (single header line) off the content.
  const headerMatch = content.match(/^(## [^\n]+\n\n)/);
  if (headerMatch) {
    prefix = headerMatch[1];
    content = content.slice(headerMatch[1].length);
  }
  return prefix + sanitizeModelOutput(content) + suffix;
}

// Export internals for targeted unit tests.
export { neutralizeMentionsOutsideCode, neutralizeMentionsInLine, neutralizeAlerts };
