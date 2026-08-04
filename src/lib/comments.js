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
 * Upsert the single summary review comment on a PR.
 *
 * 1. List issue comments, PAGINATING fully (page=1, per_page=100, loop until a
 *    short page) so the marker lookup inspects EVERY comment — not just the
 *    first 100. Without full pagination a PR with >100 comments would lose the
 *    marker comment from the visible window and create a duplicate summary on
 *    every run.
 * 2. Find the first whose body contains `marker` (default {@link MARKER}).
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
      comments.find((c) => typeof c?.body === 'string' && c.body.includes(marker)) ?? null;
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
