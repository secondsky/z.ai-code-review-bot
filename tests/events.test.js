import {
  eventName,
  isPullRequestEvent,
  isIssueCommentEvent,
  isScheduleEvent,
  getPullNumber,
  isForkPullRequest,
  getCommenter,
  isBotComment,
} from '../src/lib/events.js';

describe('eventName', () => {
  test('returns context.eventName', () => {
    expect(eventName({ eventName: 'pull_request' })).toBe('pull_request');
    expect(eventName({ eventName: 'issue_comment' })).toBe('issue_comment');
  });
  test('returns undefined when missing', () => {
    expect(eventName({})).toBeUndefined();
    expect(eventName(undefined)).toBeUndefined();
    expect(eventName(null)).toBeUndefined();
  });
});

describe('event-type predicates', () => {
  test('isPullRequestEvent', () => {
    expect(isPullRequestEvent({ eventName: 'pull_request' })).toBe(true);
    expect(isPullRequestEvent({ eventName: 'issue_comment' })).toBe(false);
    expect(isPullRequestEvent({})).toBe(false);
    expect(isPullRequestEvent(undefined)).toBe(false);
  });

  test('isIssueCommentEvent', () => {
    expect(isIssueCommentEvent({ eventName: 'issue_comment' })).toBe(true);
    expect(isIssueCommentEvent({ eventName: 'pull_request' })).toBe(false);
    expect(isIssueCommentEvent({})).toBe(false);
    expect(isIssueCommentEvent(undefined)).toBe(false);
  });

  test('isScheduleEvent', () => {
    expect(isScheduleEvent({ eventName: 'schedule' })).toBe(true);
    expect(isScheduleEvent({ eventName: 'pull_request' })).toBe(false);
    expect(isScheduleEvent({})).toBe(false);
    expect(isScheduleEvent(undefined)).toBe(false);
  });
});

describe('getPullNumber', () => {
  test('pull_request event returns pull_request.number', () => {
    const ctx = { eventName: 'pull_request', payload: { pull_request: { number: 42 } } };
    expect(getPullNumber(ctx)).toBe(42);
  });

  test('pull_request event with missing pull_request returns null', () => {
    const ctx = { eventName: 'pull_request', payload: {} };
    expect(getPullNumber(ctx)).toBeNull();
  });

  test('issue_comment on a PR returns issue.number', () => {
    const ctx = {
      eventName: 'issue_comment',
      payload: { issue: { number: 7, pull_request: { url: 'x' } } },
    };
    expect(getPullNumber(ctx)).toBe(7);
  });

  test('issue_comment on a plain issue (no pull_request) returns null', () => {
    const ctx = { eventName: 'issue_comment', payload: { issue: { number: 9 } } };
    expect(getPullNumber(ctx)).toBeNull();
  });

  test('issue_comment with no issue returns null', () => {
    const ctx = { eventName: 'issue_comment', payload: {} };
    expect(getPullNumber(ctx)).toBeNull();
  });

  test('issue_comment on a PR without a number returns null', () => {
    const ctx = {
      eventName: 'issue_comment',
      payload: { issue: { pull_request: { url: 'x' } } },
    };
    expect(getPullNumber(ctx)).toBeNull();
  });

  test('other event types return null', () => {
    expect(getPullNumber({ eventName: 'schedule', payload: {} })).toBeNull();
    expect(getPullNumber({ eventName: 'push', payload: {} })).toBeNull();
  });

  test('tolerates missing context / payload', () => {
    expect(getPullNumber(undefined)).toBeNull();
    expect(getPullNumber(null)).toBeNull();
    expect(getPullNumber({ eventName: 'pull_request' })).toBeNull();
  });
});

describe('isForkPullRequest', () => {
  test('true for pull_request with head.repo.fork === true', () => {
    const ctx = {
      eventName: 'pull_request',
      payload: { pull_request: { head: { repo: { fork: true } } } },
    };
    expect(isForkPullRequest(ctx)).toBe(true);
  });

  test('false for pull_request with fork === false', () => {
    const ctx = {
      eventName: 'pull_request',
      payload: { pull_request: { head: { repo: { fork: false } } } },
    };
    expect(isForkPullRequest(ctx)).toBe(false);
  });

  test('false for pull_request with missing fork flag', () => {
    const ctx = {
      eventName: 'pull_request',
      payload: { pull_request: { head: { repo: {} } } },
    };
    expect(isForkPullRequest(ctx)).toBe(false);
  });

  test('false for issue_comment on a PR (fork-ness not determinable here)', () => {
    const ctx = {
      eventName: 'issue_comment',
      payload: { issue: { number: 1, pull_request: { url: 'x' } } },
    };
    expect(isForkPullRequest(ctx)).toBe(false);
  });

  test('false for non-PR contexts', () => {
    expect(isForkPullRequest({ eventName: 'schedule', payload: {} })).toBe(false);
    expect(isForkPullRequest(undefined)).toBe(false);
  });
});

describe('getCommenter', () => {
  const user = { login: 'alice', author_association: 'OWNER' };

  test('issue_comment prefers payload.comment.user', () => {
    const ctx = { eventName: 'issue_comment', payload: { comment: { user } } };
    expect(getCommenter(ctx)).toEqual({ login: 'alice', author_association: 'OWNER' });
  });

  test('issue_comment falls back to payload.sender when no comment.user', () => {
    const ctx = { eventName: 'issue_comment', payload: { sender: user } };
    expect(getCommenter(ctx)).toEqual({ login: 'alice', author_association: 'OWNER' });
  });

  test('returns null when neither comment.user nor sender exist', () => {
    const ctx = { eventName: 'issue_comment', payload: {} };
    expect(getCommenter(ctx)).toBeNull();
  });

  test('returns null for non-issue-comment events', () => {
    expect(getCommenter({ eventName: 'pull_request', payload: {} })).toBeNull();
    expect(getCommenter(undefined)).toBeNull();
  });
});

describe('isBotComment', () => {
  test('true for a comment author whose login ends with [bot]', () => {
    const ctx = {
      eventName: 'issue_comment',
      payload: { comment: { user: { login: 'dependabot[bot]', author_association: 'NONE' } } },
    };
    expect(isBotComment(ctx)).toBe(true);
  });

  test('case-insensitive on the [bot] suffix', () => {
    const ctx = {
      eventName: 'issue_comment',
      payload: { comment: { user: { login: 'SomeApp[BOT]', author_association: 'NONE' } } },
    };
    expect(isBotComment(ctx)).toBe(true);
  });

  test('false for a human comment author', () => {
    const ctx = {
      eventName: 'issue_comment',
      payload: { comment: { user: { login: 'alice', author_association: 'OWNER' } } },
    };
    expect(isBotComment(ctx)).toBe(false);
  });

  test('false when there is no comment author', () => {
    const ctx = { eventName: 'issue_comment', payload: {} };
    expect(isBotComment(ctx)).toBe(false);
  });

  test('false for non-issue-comment events', () => {
    expect(isBotComment({ eventName: 'pull_request', payload: {} })).toBe(false);
    expect(isBotComment(undefined)).toBe(false);
  });
});
