/**
 * Idempotent summary-comment upsert for PR reviews.
 *
 * Posts a SINGLE summary comment per PR, updated in place via a hidden HTML
 * comment marker so re-runs (e.g. on `synchronize`) don't pile up duplicates.
 *
 * Octokit and `@actions/core`-like `core` are INJECTED — never imported at
 * module load — so this module stays pure and unit-testable.
 */

import { sanitizeCommentBody } from './sanitize-output.js';

/** Hidden HTML comment marker used to find the existing review comment. */
export const MARKER = '<!-- zai-code-review -->';

/**
 * Hard cap on pagination depth for the marker lookup in
 * {@link upsertReviewComment}. Defense-in-depth (CORE-4): the loop terminates
 * on a short page OR when the marker comment is found, but a misbehaving
 * endpoint that always returns full pages AND never contains the marker would
 * loop forever. 100 pages × 100 per page = 10,000 comments — beyond any real
 * PR's comment history.
 */
const MAX_COMMENT_PAGES = 100;

/**
 * Determine whether a comment was authored by a bot. Used to gate marker-based
 * matching so a drive-by human commenter cannot post the marker and cause the
 * bot to overwrite THEIR comment on every run (comment hijack). Accepts EITHER
 * signal GitHub surfaces for bot accounts: `user.type === 'Bot'` (GitHub Apps
 * bot accounts) OR `user.login` ending in `[bot]` (actions and other bots).
 *
 * @param {{user?: {type?: string, login?: string}}} comment
 * @returns {boolean}
 */
function isBotComment(comment) {
  const user = comment?.user;
  if (!user) return false;
  if (typeof user.type === 'string' && user.type === 'Bot') return true;
  return typeof user.login === 'string' && user.login.endsWith('[bot]');
}

/**
 * Build the comment body from a title and content, appending the marker. The
 * model `content` is run through the output sanitizer first so an indirect
 * prompt-injection cannot coax the bot into emitting @mention spam or forged
 * GitHub alert banners under its trusted identity. The title and marker are
 * preserved verbatim (the marker must remain byte-exact for idempotent upsert).
 *
 * The CALLER normally uses this to assemble the body before passing it to
 * `upsertReviewComment`; `upsertReviewComment` itself never mutates the body.
 *
 * @param {{title?: string, content: string, marker: string}} args
 * @returns {string}
 */
export function buildCommentBody({ title, content, marker }) {
  // Sanitize the model output only; the title/marker are operator-controlled.
  const safeContent = sanitizeCommentBody(String(content ?? ''));
  // W5-9: some callers (formatFindingsAsSummary, formatWalkthroughSummary)
  // emit content that ALREADY starts with `## <reviewerName>` and ends with
  // the marker. Re-wrapping would produce a duplicate H2 heading and a
  // duplicate trailing marker on the rendered PR comment. When the sanitized
  // content already carries both, return it verbatim instead of re-wrapping.
  // W11-8: tolerate trailing horizontal whitespace after the heading text
  // (`## Title \n`), which used to fail the exact-string check and produced a
  // duplicate H2 heading. Compare on the first line with trailing whitespace
  // stripped.
  const trimmed = safeContent.trimEnd();
  // W13-1: when content has no newline, indexOf('\n') returns -1 and
  // Math.max(0,-1)=0, making firstLine='' — which always fails the heading
  // check and produces a duplicate H2. Handle the no-newline case: the whole
  // trimmed string IS the first line.
  const nlIdx = trimmed.indexOf('\n');
  const firstLine = nlIdx === -1 ? trimmed : trimmed.slice(0, nlIdx);
  const hasHeading = !!title && firstLine.replace(/[ \t]+$/, '') === `## ${title}`;
  const hasMarker = trimmed.endsWith(marker);
  if (hasHeading && hasMarker) {
    return trimmed;
  }
  // W12-3b: content already has the heading but NOT the marker — append the
  // marker without re-wrapping (re-wrapping would duplicate the heading).
  if (hasHeading) {
    return `${trimmed}\n\n${marker}`;
  }
  if (title) {
    return `## ${title}\n\n${safeContent}\n\n${marker}`;
  }
  return `${safeContent}\n\n${marker}`;
}

/**
 * Append hidden HTML-comment "trailer" blocks to a body.
 *
 * Used to attach the incremental-review hash block and the schedule-dedup SHA
 * block after a review/comment body. Empty/falsy blocks are dropped; the rest
 * are joined with newlines and appended after a separating newline. Returns
 * the body unchanged when no non-empty trailers are supplied.
 *
 * Centralized so the separator and empty-filtering logic stays consistent
 * across every body-construction site (inline review, summary comment,
 * scheduled review).
 *
 * @param {string} body  The base body (already includes the marker).
 * @param {Array<string|null|undefined>} trailers  Hidden-comment blocks to append.
 * @returns {string}
 */
export function appendTrailers(body, trailers = []) {
  const list = Array.isArray(trailers)
    ? trailers.filter((s) => typeof s === 'string' && s.length > 0)
    : [];
  if (list.length === 0) return body;
  return `${body}\n${list.join('\n')}`;
}

/**
 * Find the bot-authored marker comment on an issue/PR.
 *
 * Extracted from the lookup loop inside {@link upsertReviewComment} (W15-A8-3)
 * so other call sites can reuse the exact same pagination + bot-authority
 * gating — notably the incremental-review hash-block read in src/index.js,
 * which must never trust a human comment carrying a forged marker/hash block.
 *
 * Pagination mirrors {@link upsertReviewComment}: per_page=100, loop until a
 * short page, the marker comment is found, or {@link MAX_COMMENT_PAGES} is
 * reached (CORE-4 loop guard). Bot authorship is REQUIRED (comment hijack
 * defense): only `user.type === 'Bot'` OR `user.login` ending in `[bot]` is
 * eligible.
 *
 * `listComments` rejections propagate (not swallowed) — callers wrap in their
 * own fail-soft boundary.
 *
 * @param {object} args
 * @param {object} args.octokit      Octokit instance (rest.issues.listComments used).
 * @param {string} args.owner        Repository owner.
 * @param {string} args.repo         Repository name.
 * @param {number} args.issueNumber  PR / issue number.
 * @param {string} [args.marker]     Marker used to locate the comment (default {@link MARKER}).
 * @param {number} [args.perPage=100] Page size for listComments pagination.
 * @returns {Promise<{id:number, body?:string}|null>} the found comment, or null.
 */
export async function findBotMarkerComment({
  octokit,
  owner,
  repo,
  issueNumber,
  marker = MARKER,
  perPage = 100,
}) {
  // Paginate fully: the marker comment can be anywhere in the history, and a
  // single page would miss it on high-traffic PRs. CORE-4: cap at
  // MAX_COMMENT_PAGES so a misbehaving endpoint cannot trap us in an
  // unbounded loop when the marker is absent.
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: perPage,
      page,
    });
    const existing =
      comments.find(
        (c) => isBotComment(c) && typeof c?.body === 'string' && c.body.includes(marker),
      ) ?? null;
    if (existing) return existing; // found it — no need to fetch more pages
    if (comments.length < perPage) return null; // last page reached
  }
  return null;
}

/**
 * Upsert the single summary review comment on a PR.
 *
 * 1. List issue comments, PAGINATING fully (page=1, per_page=100, loop until a
 *    short page) so the marker lookup inspects EVERY comment — not just the
 *    first 100. Without full pagination a PR with >100 comments would lose the
 *    marker comment from the visible window and create a duplicate summary on
 *    every run. (Delegated to {@link findBotMarkerComment}.)
 * 2. Find the first BOT-AUTHORED comment whose body contains `marker` (default
 *    {@link MARKER}). The author check (`user.type === 'Bot'` OR `user.login`
 *    ends with `[bot]`) is mandatory: without it, a non-bot user could post a
 *    comment containing the marker and the bot would overwrite THEIR comment on
 *    every run — a comment-hijack that lets an attacker masquerade as the bot.
 * 3. Update it if found, otherwise create a new comment.
 *
 * `listComments` rejections propagate (not swallowed).
 *
 * @param {object} args
 * @param {object} args.octokit  Octokit instance (rest.issues.* used).
 * @param {string} args.owner    Repository owner.
 * @param {string} args.repo     Repository name.
 * @param {number} args.issueNumber  PR / issue number.
 * @param {string} args.body     Comment body (already includes marker if desired).
 * @param {string} [args.marker] Marker used to locate the existing comment.
 * @param {number} [args.perPage=100] Page size for listComments pagination.
 * @param {{info?: Function}} [args.core]  Optional @actions/core-like logger.
 * @returns {Promise<{action: 'updated'|'created', commentId: number}>}
 */
export async function upsertReviewComment({
  octokit,
  owner,
  repo,
  issueNumber,
  body,
  marker = MARKER,
  perPage = 100,
  core,
}) {
  const existing = await findBotMarkerComment({
    octokit,
    owner,
    repo,
    issueNumber,
    marker,
    perPage,
  });

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
    if (core?.info) core.info(`Updated existing review comment ${existing.id}`);
    return { action: 'updated', commentId: existing.id };
  }

  const { data: created } = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
  if (core?.info) core.info(`Created review comment ${created.id}`);
  return { action: 'created', commentId: created.id };
}
