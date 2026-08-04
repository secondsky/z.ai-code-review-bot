/**
 * Shared helpers used by every `/zai` command handler.
 *
 * Two small, defensive wrappers around the injected octokit:
 *   - `postComment`     → create an issue comment (command response).
 *   - `getPRContext`    → fetch minimal PR metadata for prompt-building.
 *
 * Both are defensive on a missing/malformed `context`: they return a sane
 * sentinel (`null`) rather than throwing, so a handler that calls them can
 * decide how to degrade (typically: post a short guidance/error comment and
 * return). Octokit is ALWAYS a parameter — never imported — so this module
 * stays pure and unit-testable.
 *
 * No handler imports `@actions/core` or hits the network directly.
 */

/**
 * Post a command-response comment on the PR/issue.
 *
 * Uses `octokit.rest.issues.createComment` (a PLAIN create, NOT the marker
 * upsert from comments.js — each command gets its OWN comment, distinct from
 * the auto-review summary marker).
 *
 * `owner`/`repo` come from `context.repo`; `issue_number` from
 * `context.payload.issue.number` (issue_comment events carry the issue number
 * which equals the PR number).
 *
 * @param {object} args
 * @param {object} args.octokit   Octokit instance.
 * @param {object} args.context   @actions/github context (or same shape).
 * @param {string} args.body      Comment body.
 * @returns {Promise<object|null>}  The created comment data, or `null` if the
 *   context was missing the fields needed to post (defensive no-op).
 */
export async function postComment({ octokit, context, body }) {
  const owner = context?.repo?.owner;
  const repo = context?.repo?.repo;
  const issueNumber = context?.payload?.issue?.number;
  if (!owner || !repo || typeof issueNumber !== 'number') {
    return null;
  }
  const { data } = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
  return data;
}

/**
 * Fetch minimal PR metadata for prompt-building.
 *
 * Returns `{ title, body, headBranch, baseBranch, headSha }` via
 * `octokit.rest.pulls.get({ owner, repo, pull_number })` where `pull_number`
 * is `context.payload.issue.number`. Keeps the payload minimal on purpose —
 * per-file fetching is the caller's job (each handler fetches what it needs).
 *
 * `headSha` is exposed so handlers can fetch a stable file snapshot via
 * `repos.getContent` without trusting the `issue_comment` payload, which does
 * NOT carry the PR head SHA (only `payload.issue.pull_request`, a minimal
 * reference with no `head.sha`).
 *
 * Defensive: returns `null` (and fetches nothing) when context is missing the
 * owner/repo/issue-number fields.
 *
 * @param {object} args
 * @param {object} args.octokit
 * @param {object} args.context
 * @returns {Promise<{title: string, body: string, headBranch: string, baseBranch: string, headSha: string}|null>}
 */
export async function getPRContext({ octokit, context }) {
  const owner = context?.repo?.owner;
  const repo = context?.repo?.repo;
  const pullNumber = context?.payload?.issue?.number;
  if (!owner || !repo || typeof pullNumber !== 'number') {
    return null;
  }
  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });
  return {
    title: typeof data?.title === 'string' ? data.title : '',
    body: typeof data?.body === 'string' ? data.body : '',
    headBranch: data?.head?.ref ?? '',
    baseBranch: data?.base?.ref ?? '',
    headSha: data?.head?.sha ?? '',
  };
}
