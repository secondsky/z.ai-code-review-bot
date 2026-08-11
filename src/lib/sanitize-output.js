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
// W11-2: GitHub renders alert banners at any blockquote nesting depth
// (`> [!WARNING]`, `>> [!WARNING]`, `> > [!NOTE]`, …). The regex used to match
// exactly one `>`; it now matches one-or-more (`>+`) so nested banners are
// neutralized too.
const ALERT_RE = new RegExp(
  // An optional blockquote prefix (one or more `>`), then the [!TYPE] marker.
  // We anchor on start-of-line so a quoted `[!NOTE]` mid-paragraph is unaffected.
  String.raw`(^|\n)(\s*>+\s*)\[!(${ALERT_TYPES.join('|')})\]`,
  'gi',
);

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
// SCN-17: a backtick is intentionally included in the negated boundary class so
// ``foo`@user`` (an identifier-like token) is not treated as a mention. But that
// also meant a backtick IMMEDIATELY before `@` (e.g. "see `@evilspammer") left
// the `@` without a usable boundary and the mention survived. The fix: also
// match a leading backtick as a boundary, but capture it separately so it is
// preserved verbatim in the replacement (the backtick is not part of the
// mention). The replacement re-emits the backtick followed by the neutralized
// mention. This keeps the original text visually identical while inserting the
// ZWSP that breaks GitHub's mention parser.
// W11-1: the org/team alternative used to include \s in its char class
// (`(?:\/[A-Za-z0-9_\s-]+)?`). The greedy match swallowed the space between a
// slash-team mention and a following plain mention (e.g. `@org/x @lead`), so
// the second `@lead` lost its leading boundary char and survived neutralization
// — a real notification-spam bypass. GitHub team names cannot contain
// whitespace, so \s has been removed from both alternatives.
// W12-1a: "/" was in the negated boundary class to protect URLs like
// `https://user@host`. But that also blocked neutralization of `path/@user`
// and `@lead/@junior` — GitHub DOES render @mentions after a "/". URLs like
// `https://user@host` already don't match because the char before "@" is a
// word char (\w), so the boundary fails WITHOUT needing "/" in the exclusion.
const MENTION_RE = /(^|[^\w`\\])@([A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9_-]+)?)|(`)@([A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9_-]+)?)/g;

function neutralizeMentionsOutsideCode(text) {
  const lines = text.split('\n');
  let inFence = false; // ``` fence state, tracked across lines
  // Index in `out` of the most recent OPENING fence line, or -1 when the last
  // seen fence was properly closed. If the loop ends with inFence === true
  // (an unclosed fence), we re-neutralize the lines after this opening line so
  // an attacker cannot smuggle @mentions through by leaving a fence open (C02).
  let unclosedStart = -1;
  const out = [];
  for (const line of lines) {
    // Toggle fence state if the line opens/closes a ``` block.
    // A fenced block starts/ends with a line whose trimmed content begins with
    // ``` (optionally with a language tag or indentation). We count opening vs
    // closing delimiters naively: if a line has ``` and we're not in a fence,
    // enter; if we are in a fence and the line is a closing ```, exit.
    // W12-2a: also detect fences inside blockquotes ("> ```", ">> ```", etc.)
    // so @mentions inside blockquoted code blocks are preserved.
    if (/^(?:\s*>)*\s*```/.test(line)) {
      if (inFence) {
        inFence = false;
        unclosedStart = -1; // this fence closed cleanly
        out.push(line);
        continue;
      }
      inFence = true;
      unclosedStart = out.length; // index where the opening fence line lands
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line); // inside fence: never touch
      continue;
    }
    // W11-2: apply alert-banner neutralization on the same non-fence lines as
    // mentions, so alert syntax inside a fenced code block is preserved (it is
    // not rendered as a banner by GitHub inside code).
    out.push(neutralizeAlertsLine(neutralizeMentionsInLine(line)));
  }
  // C02: a fence was opened but never closed. The lines after the opening fence
  // line were treated as "inside fence" and pushed verbatim — but a properly
  // formed review would have closed the fence, so those lines are actually
  // prose and their @mentions must be neutralized. Re-process them now. The
  // opening fence line itself is left as-is.
  if (unclosedStart >= 0) {
    for (let i = unclosedStart + 1; i < out.length; i++) {
      out[i] = neutralizeAlertsLine(neutralizeMentionsInLine(out[i]));
    }
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
  // W12-3a: match double-backtick (``...``) BEFORE single-backtick so GitHub's
  // ``@user`` syntax is treated as code, not prose. The alternation tries the
  // longer ``...`` first, then falls back to `...`.
  const segments = line.split(/(``[^`]*``|`[^`]*`)/g);
  return segments
    .map((seg, i) => {
      // Inline code segments start and end with a backtick (or double backtick).
      if (i % 2 === 1) return seg;
      return seg.replace(MENTION_RE, (full, pre, name, bt, btName) => {
        // Two alternatives in MENTION_RE:
        //   1. (^|[^\w`\\/])@(name)   — boundary char (or start) then @
        //   2. (`)@(btName)           — SCN-17: a backtick immediately before @
        // Re-emit the boundary/backtick verbatim, insert ZWSP after @.
        if (bt !== undefined) return `${bt}@\u200b${btName}`;
        return `${pre}@\u200b${name}`;
      });
    })
    .join('');
}

// Line-scoped alert-banner regex: matches `>`-prefix banner markers at the
// start of a single line (no `\n` boundary). Used by neutralizeAlertsLine so
// we can apply alert neutralization per-line inside the fence-aware loop.
const ALERT_LINE_RE = new RegExp(
  String.raw`^(\s*>+\s*)\[!(${ALERT_TYPES.join('|')})\]`,
  'i',
);

/**
 * Neutralize GitHub alert-banner syntax on a single line. Returns the line
 * with the leading `[` of a `> [!TYPE]` marker dropped (at any blockquote
 * nesting depth), so GitHub renders it as plain quoted text instead of an
 * official callout banner.
 */
function neutralizeAlertsLine(line) {
  return line.replace(ALERT_LINE_RE, (full, quotePrefix, type) => {
    return `${quotePrefix}!${type.toUpperCase()}`;
  });
}

/**
 * Neutralize GitHub alert-banner syntax. Rewrites `> [!WARNING]` (case-
 * insensitive, optional blockquote, any nesting depth) so the leading `[` is
 * dropped; GitHub then renders it as plain quoted text instead of the official
 * callout banner.
 *
 * NOTE: this full-text variant is NOT fence-aware. Callers that need to skip
 * fenced code blocks (the default sanitize path) go through
 * `neutralizeMentionsOutsideCode`, which calls `neutralizeAlertsLine` per
 * non-fence line. This function is kept for the exported surface and for tests
 * that exercise the alert regex in isolation.
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
 * Defense-in-depth (SCN-15 / W2-2): strip any forged `<!-- zai-... -->` HTML
 * comment from model output.
 *
 * `parseFindingsHashBlock` and friends trust these comments when reading PRIOR
 * bot reviews. The scheduled-review path also trusts `<!-- zai-sha:... -->`
 * (via `hasReviewForSha`). An attacker who can plant prompt-injection in a PR
 * diff could coax the model into emitting a forged marker in its OWN review
 * output, which would then be parsed as a trusted prior-review marker on the
 * next run (suppressing legitimate findings or scheduled reviews). Stripping
 * such markers from model output BEFORE it is posted closes that vector.
 *
 * W2-2: the original implementation only stripped `zai-hashes` and
 * `zai-description` and only on a line-anchored match. A forged `<!-- zai-sha:
 * ... -->` survived, and so did a marker embedded mid-line. The regex now
 * matches ANY `zai-`-prefixed HTML comment ANYWHERE in the text (not line
 * anchored), so all current and future `zai-*` markers are covered and a
 * forger cannot escape by placing the comment mid-line.
 *
 * Legitimate (non-`zai-`) HTML comments are preserved.
 *
 * @param {string} text
 * @returns {string}
 */
function stripForgedHashBlocks(text) {
  // Drop any HTML comment containing a `zai-` prefix. Apply globally (not line-
  // anchored) so a mid-line forgery like `text <!-- zai-sha:x --> more` is also
  // stripped (W2-SEC-2A). `[^>]*` is sufficient here: HTML comment bodies do not
  // contain `>` in practice, and we are sanitizing untrusted model output, not
  // parsing arbitrary HTML.
  return text.replace(/<!--\s*zai-[^>]*-->/g, '');
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
  //    spam can't escape the sanitizer via truncation timing. Both passes are
  //    applied inside neutralizeMentionsOutsideCode's fence-aware loop, so
  //    neither touches text inside ``` blocks (W11-2: alert syntax inside a
  //    fenced code block is not rendered as a banner and must be preserved).
  let out = neutralizeMentionsOutsideCode(text);
  // SCN-15 / W2-2: strip any forged zai-* HTML comment markers that an attacker
  // might coax the model into emitting via prompt injection (hashes, description,
  // sha, etc.). Applied globally so mid-line forgeries are also caught.
  out = stripForgedHashBlocks(out);

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
export { neutralizeMentionsOutsideCode, neutralizeMentionsInLine, neutralizeAlerts, stripForgedHashBlocks };
