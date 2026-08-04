/**
 * Idempotent summary-comment upsert for PR reviews.
 *
 * Posts a SINGLE summary comment per PR, updated in place via a hidden HTML
 * comment marker so re-runs (e.g. on `synchronize`) don't pile up duplicates.
 *
 * Octokit and `@actions/core`-like `core` are INJECTED — never imported at
 * module load — so this module stays pure and unit-testable.
 */

/** Hidden HTML comment marker used to find the existing review comment. */
export const MARKER = '<!-- zai-code-review -->';

/**
 * Build the comment body from a title and content, appending the marker.
 * The CALLER normally uses this to assemble the body before passing it to
 * `upsertReviewComment`; `upsertReviewComment` itself never mutates the body.
 *
 * @param {{title?: string, content: string, marker: string}} args
 * @returns {string}
 */
export function buildCommentBody({ title, content, marker }) {
  if (title) {
    return `## ${title}\n\n${content}\n\n${marker}`;
  }
  return `${content}\n\n${marker}`;
}

/**
 * Upsert the single summary review comment on a PR.
 *
 * 1. List issue comments.
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
  core,
}) {
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
  });

  const existing = comments.find((c) => typeof c?.body === 'string' && c.body.includes(marker));

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
