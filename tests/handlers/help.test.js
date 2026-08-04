/**
 * Tests for src/lib/handlers/help.js — static help text.
 *
 * The simplest handler: no callApi, no PR context. Posts a markdown table of
 * the commands (from ALLOWED_COMMANDS) with one-line descriptions.
 */
import { describe, it, expect, vi } from 'vitest';
import { handleHelpCommand } from '../../src/lib/handlers/help.js';

function makeOctokit() {
  const calls = { createComment: [] };
  const octokit = {
    rest: {
      issues: {
        async createComment(params) {
          calls.createComment.push(params);
          return { data: { id: 1 } };
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

describe('handleHelpCommand', () => {
  it('posts a comment containing the command list; no callApi', async () => {
    const octokit = makeOctokit();
    const context = makeContext();
    const core = { info: vi.fn(), warning: vi.fn() };
    const callApi = vi.fn();

    await handleHelpCommand({
      octokit,
      context,
      config: {},
      core,
      commenter: { login: 'alice' },
      args: '',
      callApi,
    });

    expect(callApi).not.toHaveBeenCalled();
    expect(octokit.__calls.createComment).toHaveLength(1);
    const body = octokit.__calls.createComment[0].body;
    // Every command appears, with its one-line description.
    expect(body).toContain('`/zai ask`');
    expect(body).toContain('Ask a question about the PR');
    expect(body).toContain('`/zai review`');
    expect(body).toContain('Review a specific file (or the whole PR if no arg)');
    expect(body).toContain('`/zai explain`');
    expect(body).toContain('Explain a line range');
    expect(body).toContain('`/zai describe`');
    expect(body).toContain('Generate a PR description');
    expect(body).toContain('`/zai impact`');
    expect(body).toContain("Assess the change's impact/risk");
    expect(body).toContain('`/zai help`');
    expect(body).toContain('Show this help');
  });

  it('is posted to the issue from context.payload.issue.number', async () => {
    const octokit = makeOctokit();
    const context = makeContext({ number: 77 });

    await handleHelpCommand({
      octokit,
      context,
      config: {},
      commenter: { login: 'x' },
      args: '',
      callApi: vi.fn(),
    });

    expect(octokit.__calls.createComment[0]).toMatchObject({
      owner: 'owner',
      repo: 'repo',
      issue_number: 77,
    });
  });

  it('returns without throwing when postComment fails (missing context)', async () => {
    const core = { info: vi.fn(), warning: vi.fn() };
    // No context → postComment is a defensive no-op; handler must not throw.
    await expect(
      handleHelpCommand({
        octokit: makeOctokit(),
        context: undefined,
        config: {},
        core,
        commenter: { login: 'x' },
        args: '',
        callApi: vi.fn(),
      }),
    ).resolves.toBeUndefined();
  });
});
