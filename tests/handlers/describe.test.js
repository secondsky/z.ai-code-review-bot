/**
 * Tests for src/lib/handlers/describe.js — generate a PR description.
 *
 * v1 is READ-ONLY: the description is posted as a COMMENT only; the PR body is
 * NEVER mutated (no pulls.update). These tests assert both the happy path and
 * the read-only invariant.
 */
import { describe, it, expect, vi } from 'vitest';
import { handleDescribeCommand } from '../../src/lib/handlers/describe.js';

function makeOctokit({
  commits = [{ commit: { message: 'feat: add x' } }],
  files = [{ filename: 'src/a.js', status: 'added', patch: '+a' }],
} = {}) {
  const calls = {
    createComment: [],
    listCommits: [],
    listFiles: [],
    update: [], // MUST stay empty (read-only).
  };
  const octokit = {
    rest: {
      issues: {
        async createComment(params) {
          calls.createComment.push(params);
          return { data: { id: 1 } };
        },
      },
      pulls: {
        async listCommits(params) {
          calls.listCommits.push(params);
          return { data: commits };
        },
        async listFiles(params) {
          calls.listFiles.push(params);
          return { data: files };
        },
        async update(params) {
          calls.update.push(params);
          return { data: {} };
        },
      },
    },
  };
  octokit.__calls = calls;
  return octokit;
}

function makeContext({ number = 42 } = {}) {
  return {
    repo: { owner: 'owner', repo: 'repo' },
    payload: { issue: { number } },
  };
}

describe('handleDescribeCommand — success', () => {
  it('calls callApi once with a structured-description prompt and posts the result', async () => {
    const octokit = makeOctokit();
    const callApi = vi.fn(async () => '## Overview\n...');

    await handleDescribeCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm' },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });

    expect(callApi).toHaveBeenCalledTimes(1);
    const prompt = callApi.mock.calls[0][2];
    // Structured sections requested.
    expect(prompt).toContain('Overview');
    expect(prompt).toContain('Features');
    expect(prompt).toContain('Bug Fixes');
    // Commits + files fed in.
    expect(prompt).toContain('feat: add x');
    expect(prompt).toContain('src/a.js');
    // Result posted.
    expect(octokit.__calls.createComment[0].body).toContain('## Overview');
  });

  it('fetches commits and files for the PR number', async () => {
    const octokit = makeOctokit();
    const callApi = vi.fn(async () => 'desc');
    await handleDescribeCommand({
      octokit,
      context: makeContext({ number: 99 }),
      config: { apiKey: 'k', model: 'm' },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });
    expect(octokit.__calls.listCommits[0]).toMatchObject({
      owner: 'owner',
      repo: 'repo',
      pull_number: 99,
    });
    expect(octokit.__calls.listFiles[0]).toMatchObject({ pull_number: 99 });
  });
});

describe('handleDescribeCommand — read-only invariant', () => {
  it('NEVER calls pulls.update (does not mutate the PR body)', async () => {
    const octokit = makeOctokit();
    const callApi = vi.fn(async () => 'description');
    await handleDescribeCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm' },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });
    expect(octokit.__calls.update).toHaveLength(0);
    // Posted as a comment instead.
    expect(octokit.__calls.createComment).toHaveLength(1);
  });
});

describe('handleDescribeCommand — error path', () => {
  it('callApi rejects → short error comment, no throw', async () => {
    const octokit = makeOctokit();
    const core = { info: vi.fn(), warning: vi.fn() };
    const callApi = vi.fn(async () => {
      throw new Error('nope');
    });
    await expect(
      handleDescribeCommand({
        octokit,
        context: makeContext(),
        config: { apiKey: 'k', model: 'm' },
        commenter: { login: 'a' },
        args: '',
        callApi,
        core,
      }),
    ).resolves.toBeUndefined();
    const body = octokit.__calls.createComment[0].body;
    expect(body).toContain('Z.ai request failed');
    expect(body).not.toContain('nope');
    expect(core.warning).toHaveBeenCalled();
  });
});
