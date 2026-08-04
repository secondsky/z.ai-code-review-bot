/**
 * Tests for src/lib/handlers/_shared.js — postComment + getPRContext.
 *
 * These are the two small shared helpers used by every command handler.
 * Pure injection: a fake octokit captures calls; no network.
 */
import { describe, it, expect, vi } from 'vitest';
import { postComment, getPRContext } from '../../src/lib/handlers/_shared.js';

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
});

/* ------------------------------------------------------------------ *
 * getPRContext
 * ------------------------------------------------------------------ */

describe('getPRContext', () => {
  it('fetches pulls.get with owner/repo/pull_number and returns minimal metadata', async () => {
    const pr = {
      title: 'Add feature',
      body: 'This adds X',
      head: { ref: 'feature-x' },
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
    });
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
