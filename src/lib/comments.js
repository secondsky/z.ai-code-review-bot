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
 * Upsert the single summary review comment on a PR.
 *
 * 1. List issue comments, PAGINATING fully (page=1, per_page=100, loop until a
 *    short page) so the marker lookup inspects EVERY comment — not just the
 *    first 100. Without full pagination a PR with >100 comments would lose the
 *    marker comment from the visible window and create a duplicate summary on
 *    every run.
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
  // Paginate fully: the marker comment can be anywhere in the history, and a
  // single page would miss it on high-traffic PRs (creating a duplicate).
  let existing = null;
  let page = 1;
  for (;;) {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: perPage,
      page,
    });
    existing =
      comments.find(
        (c) => isBotComment(c) && typeof c?.body === 'string' && c.body.includes(marker),
      ) ?? null;
    if (existing) break; // found it — no need to fetch more pages
    if (comments.length < perPage) break; // last page reached
    page += 1;
  }

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
