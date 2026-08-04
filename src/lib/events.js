/**
 * Pure helpers that read from a GitHub Actions `context` object (the shape from
 * `@actions/github`'s `github.context`, or any plain object with the same
 * shape). The context is passed in as a parameter so this module stays pure
 * and testable — it never imports `@actions/github`.
 *
 * Every function tolerates a missing/`undefined` `context` or payload and
 * returns a sane default (`''`, `false`, or `null`) rather than throwing.
 */

/** @returns {string|undefined} */
export function eventName(context) {
  return context?.eventName;
}

/** @returns {boolean} */
export function isPullRequestEvent(context) {
  return eventName(context) === 'pull_request';
}

/** @returns {boolean} */
export function isIssueCommentEvent(context) {
  return eventName(context) === 'issue_comment';
}

/** @returns {boolean} */
export function isScheduleEvent(context) {
  return eventName(context) === 'schedule';
}

/**
 * @returns {number|null}
 */
export function getPullNumber(context) {
  if (isPullRequestEvent(context)) {
    return context.payload?.pull_request?.number ?? null;
  }
  if (isIssueCommentEvent(context)) {
    const issue = context.payload?.issue;
    // `issue.pull_request` is present on PR comments and absent on pure issues.
    if (issue && issue.pull_request) {
      return issue.number ?? null;
    }
    return null;
  }
  return null;
}

/** @returns {boolean} */
export function isForkPullRequest(context) {
  if (!isPullRequestEvent(context)) {
    // For issue_comment events on a PR, fork-ness is NOT determinable from the
    // comment payload alone — the caller resolves it via the PR elsewhere.
    return false;
  }
  return context.payload?.pull_request?.head?.repo?.fork === true;
}

/**
 * For `issue_comment` events: prefers `payload.comment.user`, falls back to
 * `payload.sender`. Returns `{ login, author_association }` from whichever
 * object was found, or `null` if neither exists. For other events: `null`.
 *
 * @returns {{ login: string, author_association: string } | null}
 */
export function getCommenter(context) {
  if (!isIssueCommentEvent(context)) {
    return null;
  }
  const user = context.payload?.comment?.user ?? context.payload?.sender;
  if (!user) {
    return null;
  }
  return { login: user.login, author_association: user.author_association };
}

/** @returns {boolean} */
export function isBotComment(context) {
  if (!isIssueCommentEvent(context)) {
    return false;
  }
  const commenter = getCommenter(context);
  if (!commenter || typeof commenter.login !== 'string') {
    return false;
  }
  return commenter.login.toLowerCase().endsWith('[bot]');
}
