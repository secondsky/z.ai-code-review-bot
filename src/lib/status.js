/**
 * Commit-status feedback for PR reviews (pending → success/failure).
 *
 * Mirrors CodeRabbit's `commit_status` feature: post a `pending` status at the
 * START of the review so developers see progress immediately, then flip it to
 * `success` (with a findings summary) or `failure` (on hard error) when done.
 * High DX value, near-zero cost.
 *
 * Octokit and a `@actions/core`-like `core` are INJECTED — never imported at
 * module load — so this module stays pure and unit-testable. Status feedback
 * is BEST-EFFORT: any API error (e.g. a missing `statuses: write` scope) is
 * logged via `core.warning` and swallowed — it must NEVER break the review.
 */

/** The fixed GitHub commit-status `context` label (the row in the checks UI). */
export const STATUS_CONTEXT = 'Z.ai Code Review';

/** GitHub truncates commit-status descriptions to 140 characters. */
const MAX_DESCRIPTION_LEN = 140;

/**
 * Truncate a description to GitHub's 140-character limit. Returns the input
 * unchanged when it already fits.
 *
 * @param {string} description
 * @returns {string}
 */
function truncateDescription(description) {
  const s = String(description ?? '');
  if (s.length <= MAX_DESCRIPTION_LEN) return s;
  return s.slice(0, MAX_DESCRIPTION_LEN);
}

/**
 * Build the success description from review results.
 *
 * Returns the "no issues" emoji form when `findingCount` is 0 (or missing),
 * otherwise the "N findings (M critical, H high)" form. Counts default to 0
 * when missing so a partial object is still safe.
 *
 * @param {{ findingCount?: number, criticalCount?: number, highCount?: number }} counts
 * @returns {string}
 */
export function buildStatusDescription({
  findingCount = 0,
  criticalCount = 0,
  highCount = 0,
} = {}) {
  const findings = Number(findingCount) || 0;
  const critical = Number(criticalCount) || 0;
  const high = Number(highCount) || 0;
  if (findings === 0) {
    return 'Review complete: no issues found ✅';
  }
  return `Review complete: ${findings} findings (${critical} critical, ${high} high)`;
}

/**
 * Post a commit status to the PR's head SHA.
 *
 * Calls `octokit.rest.repos.createCommitStatus` with the `STATUS_CONTEXT`
 * label. Owner/repo come from `context.repo`; the SHA comes from `opts.sha`
 * (the caller passes `context.payload.pull_request.head.sha`).
 *
 * FAIL-SOFT: if the API call throws (e.g. missing `statuses: write` scope),
 * the error is logged via `deps.core.warning` (when a core is provided) and
 * `false` is returned. This function NEVER throws — status feedback is
 * best-effort and must not break the review. Missing `sha`, `context.repo`,
 * or `octokit` are treated as a no-op and return `false`.
 *
 * @param {object} opts
 * @param {object} opts.octokit     Octokit instance (rest.repos.createCommitStatus used).
 * @param {object} opts.context     @actions/github context (`.repo` read for owner/repo).
 * @param {string} opts.sha         The PR head SHA to attach the status to.
 * @param {'pending'|'success'|'failure'|'error'} opts.state  Commit-status state.
 * @param {string} opts.description Short human message (truncated to 140 chars).
 * @param {string} [opts.targetUrl] Optional link (e.g. the workflow run URL).
 * @param {{ core?: { warning?: (m: string) => void } }} [deps]  Optional core-like logger.
 * @returns {Promise<boolean>} true on success, false on failure/no-op (fail-soft).
 */
export async function setReviewStatus(opts, deps = {}) {
  const { octokit, context, sha, state, description, targetUrl } = opts || {};

  // Defense: missing octokit, SHA, or context.repo is a no-op. The caller in
  // src/index.js guards the sha too, but be belt-and-suspenders so a misuse
  // from any other call site can never trigger a noisy GitHub API error.
  if (!octokit) return false;
  if (typeof sha !== 'string' || sha.length === 0) return false;
  const owner = context?.repo?.owner;
  const repo = context?.repo?.repo;
  if (!owner || !repo) return false;

  try {
    await octokit.rest.repos.createCommitStatus({
      owner,
      repo,
      sha,
      state,
      description: truncateDescription(description),
      context: STATUS_CONTEXT,
      target_url: targetUrl,
    });
    return true;
  } catch (error) {
    // Fail-soft: status feedback must never break the review. Log and move on.
    const core = deps?.core;
    if (core && typeof core.warning === 'function') {
      core.warning(
        `Failed to post commit status (${error?.message ?? String(error)}); ` +
          'continuing without status feedback.',
      );
    }
    return false;
  }
}
