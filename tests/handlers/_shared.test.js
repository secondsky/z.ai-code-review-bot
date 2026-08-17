/**
 * Tests for src/lib/handlers/_shared.js — postComment + getPRContext.
 *
 * These are the two small shared helpers used by every command handler.
 * Pure injection: a fake octokit captures calls; no network.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  postComment,
  getPRContext,
  runCommand,
  ERROR_COMMENT,
} from '../../src/lib/handlers/_shared.js';

/* ------------------------------------------------------------------ *
 * Fakes
 * ------------------------------------------------------------------ */

function makeOctokit({ pr = null, createResult = { id: 99 } } = {}) {
  const calls = { createComment: [], pullsGet: [] };
  const octokit = {
    rest: {
      issues: {
        async createComment(params) {
          calls.createComment.push(params);
          return { data: createResult };
        },
      },
      pulls: {
        async get(params) {
          calls.pullsGet.push(params);
          return { data: pr };
        },
      },
    },
  };
  octokit.__calls = calls;
  return octokit;
}

function makeContext({ number = 42, owner = 'owner', repo = 'repo' } = {}) {
  return {
    repo: { owner, repo },
    payload: { issue: { number } },
  };
}

/* ------------------------------------------------------------------ *
 * postComment
 * ------------------------------------------------------------------ */

describe('postComment', () => {
  it('calls octokit.rest.issues.createComment with owner/repo/issue_number/body', async () => {
    const octokit = makeOctokit();
    const context = makeContext();

    const result = await postComment({ octokit, context, body: 'hello' });

    expect(octokit.__calls.createComment).toEqual([
      {
        owner: 'owner',
        repo: 'repo',
        issue_number: 42,
        body: 'hello',
      },
    ]);
    expect(result).toEqual({ id: 99 });
  });

  it('returns null and posts nothing when context is missing', async () => {
    const octokit = makeOctokit();
    const result = await postComment({ octokit, context: undefined, body: 'x' });
    expect(result).toBeNull();
    expect(octokit.__calls.createComment).toHaveLength(0);
  });

  it('returns null when context.payload.issue.number is missing', async () => {
    const octokit = makeOctokit();
    const context = { repo: { owner: 'o', repo: 'r' }, payload: {} };
    const result = await postComment({ octokit, context, body: 'x' });
    expect(result).toBeNull();
    expect(octokit.__calls.createComment).toHaveLength(0);
  });

  it('returns null when context.repo is missing', async () => {
    const octokit = makeOctokit();
    const context = { payload: { issue: { number: 5 } } };
    const result = await postComment({ octokit, context, body: 'x' });
    expect(result).toBeNull();
    expect(octokit.__calls.createComment).toHaveLength(0);
  });

  it('sanitizes the body before posting (neutralizes @mentions)', async () => {
    const octokit = makeOctokit();
    const context = makeContext();
    await postComment({ octokit, context, body: 'Hey @spammer look' });
    expect(octokit.__calls.createComment[0].body).toBe('Hey @\u200bspammer look');
  });

  it('sanitizes the body before posting (neutralizes GitHub alert banners)', async () => {
    const octokit = makeOctokit();
    const context = makeContext();
    await postComment({ octokit, context, body: '> [!WARNING]\n> pre-approved' });
    expect(octokit.__calls.createComment[0].body).not.toContain('[!WARNING]');
  });

  it('leaves clean review text unchanged', async () => {
    const octokit = makeOctokit();
    const context = makeContext();
    const clean = '## Summary\n\nLooks good. Minor nit on `a.js`.';
    await postComment({ octokit, context, body: clean });
    expect(octokit.__calls.createComment[0].body).toBe(clean);
  });
});

/* ------------------------------------------------------------------ *
 * getPRContext
 * ------------------------------------------------------------------ */

describe('getPRContext', () => {
  it('fetches pulls.get with owner/repo/pull_number and returns minimal metadata', async () => {
    const pr = {
      title: 'Add feature',
      body: 'This adds X',
      head: { ref: 'feature-x', sha: 'sha-head-123', repo: { fork: false } },
      base: { ref: 'main' },
    };
    const octokit = makeOctokit({ pr });
    const context = makeContext({ number: 7, owner: 'acme', repo: 'widgets' });

    const result = await getPRContext({ octokit, context });

    expect(octokit.__calls.pullsGet).toEqual([
      { owner: 'acme', repo: 'widgets', pull_number: 7 },
    ]);
    expect(result).toEqual({
      title: 'Add feature',
      body: 'This adds X',
      headBranch: 'feature-x',
      baseBranch: 'main',
      headSha: 'sha-head-123',
      isFork: false,
    });
  });

  it('resolves isFork=true when head.repo.fork is true', async () => {
    const pr = {
      title: 'T',
      body: '',
      head: { ref: 'f', sha: 's', repo: { fork: true } },
      base: { ref: 'main' },
    };
    const octokit = makeOctokit({ pr });
    const context = makeContext();
    const result = await getPRContext({ octokit, context });
    expect(result.isFork).toBe(true);
  });

  it('tolerates a missing PR body (null) and missing ref fields', async () => {
    const pr = { title: 'T', body: null };
    const octokit = makeOctokit({ pr });
    const context = makeContext();

    const result = await getPRContext({ octokit, context });

    expect(result).toEqual({
      title: 'T',
      body: '',
      headBranch: '',
      baseBranch: '',
      headSha: '',
      isFork: false,
    });
  });

  it('returns null when context is missing', async () => {
    const octokit = makeOctokit();
    const result = await getPRContext({ octokit, context: undefined });
    expect(result).toBeNull();
    expect(octokit.__calls.pullsGet).toHaveLength(0);
  });

  it('returns null when issue number is missing', async () => {
    const octokit = makeOctokit();
    const context = { repo: { owner: 'o', repo: 'r' }, payload: {} };
    const result = await getPRContext({ octokit, context });
    expect(result).toBeNull();
    expect(octokit.__calls.pullsGet).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * runCommand — F-RUNCOMMAND: single never-throw wrapper
 *
 * Every command handler used to duplicate the same outer scaffold: a
 * local ERROR_COMMENT const + a try/catch that warned and posted the
 * error comment. Past bug classes (W16-B4-2: a post() outside the try;
 * W15-A4-2: a mutation sharing the outer catch) had to be fixed by hand
 * in individual handlers. runCommand makes the "a handler NEVER throws
 * out to the router" guardrail structural: one owner, one copy.
 * ------------------------------------------------------------------ */

describe('runCommand — F-RUNCOMMAND: never-throw wrapper', () => {
  it('fn rejects and post rejects on EVERY call → resolves without throwing, attempted the ERROR_COMMENT post', async () => {
    const core = { info: vi.fn(), warning: vi.fn() };
    const attempted = [];
    const post = async (body) => {
      attempted.push(body);
      throw new Error('502 bad gateway');
    };

    await expect(
      runCommand('ask', { core, post }, async () => {
        throw new Error('boom');
      }),
    ).resolves.toBeUndefined();

    // The fallback post was ATTEMPTED with the exact error comment…
    expect(attempted).toEqual([ERROR_COMMENT]);
    // …and even though it rejected, nothing escaped.
    expect(core.warning).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalledWith('ask handler failed: boom');
  });

  it('returns the fn result untouched on success (post never called)', async () => {
    const post = vi.fn();
    const result = await runCommand(
      'ask',
      { core: null, post },
      async () => 42,
    );
    expect(result).toBe(42);
    expect(post).not.toHaveBeenCalled();
  });

  it('tolerates a missing core (no warning crash) and still attempts the post', async () => {
    const attempted = [];
    const post = async (body) => {
      attempted.push(body);
      throw new Error('502');
    };
    await expect(
      runCommand('review', { post }, () => Promise.reject(new Error('x'))),
    ).resolves.toBeUndefined();
    expect(attempted).toEqual([ERROR_COMMENT]);
  });

  it('warns with the thrown value when it is not an Error', async () => {
    const core = { warning: vi.fn() };
    const post = vi.fn(async () => {});
    await runCommand(
      'describe',
      { core, post },
      () => Promise.reject('plain string'),
    );
    expect(core.warning).toHaveBeenCalledWith(
      'describe handler failed: plain string',
    );
    expect(post).toHaveBeenCalledWith(ERROR_COMMENT);
  });
});
