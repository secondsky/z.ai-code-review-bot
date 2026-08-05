/**
 * Tests for src/lib/handlers/review.js — review a specific file (or whole PR).
 *
 * Paths covered:
 *  - valid file → reviews just that file (callApi prompt contains ONLY that patch).
 *  - invalid file → guidance comment, no callApi.
 *  - path traversal (`..` or leading `/`) → rejected, no callApi.
 *  - no args → whole-PR review (reuses buildStructuredReviewPrompt on patchable files).
 *  - callApi rejects → short error comment, no throw.
 */
import { describe, it, expect, vi } from 'vitest';
import { handleReviewCommand } from '../../src/lib/handlers/review.js';

function makeOctokit({
  files = [
    { filename: 'src/a.js', status: 'modified', patch: 'patch-a' },
    { filename: 'src/b.js', status: 'added', patch: 'patch-b' },
  ],
} = {}) {
  const calls = { createComment: [], listFiles: [] };
  const octokit = {
    rest: {
      issues: {
        async createComment(params) {
          calls.createComment.push(params);
          return { data: { id: 1 } };
        },
      },
      pulls: {
        async listFiles(params) {
          calls.listFiles.push(params);
          return { data: files };
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

describe('handleReviewCommand — whole-PR (no args)', () => {
  it('reviews the whole PR diff (callApi prompt contains both files)', async () => {
    const octokit = makeOctokit();
    const callApi = vi.fn(async () => 'REVIEW');

    await handleReviewCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm', maxDiffChars: 0 },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });

    expect(callApi).toHaveBeenCalledTimes(1);
    const prompt = callApi.mock.calls[0][2];
    expect(prompt).toContain('src/a.js');
    expect(prompt).toContain('src/b.js');
    expect(octokit.__calls.createComment[0].body).toContain('REVIEW');
  });

  it('posts a note when there are no patchable files', async () => {
    const octokit = makeOctokit({
      files: [{ filename: 'bin', status: 'modified' /* no patch */ }],
    });
    const callApi = vi.fn();
    await handleReviewCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm' },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });
    expect(callApi).not.toHaveBeenCalled();
    expect(octokit.__calls.createComment[0].body).toContain('No textual changes');
  });
});

describe('handleReviewCommand — specific file', () => {
  it('valid file → reviews only that file', async () => {
    const octokit = makeOctokit();
    const callApi = vi.fn(async () => 'FILE-REVIEW');

    await handleReviewCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm' },
      commenter: { login: 'a' },
      args: 'src/b.js',
      callApi,
    });

    expect(callApi).toHaveBeenCalledTimes(1);
    const prompt = callApi.mock.calls[0][2];
    expect(prompt).toContain('src/b.js');
    expect(prompt).toContain('patch-b');
    expect(prompt).not.toContain('patch-a');
    expect(octokit.__calls.createComment[0].body).toContain('FILE-REVIEW');
  });

  it('invalid file → guidance comment, no callApi', async () => {
    const octokit = makeOctokit();
    const callApi = vi.fn();
    await handleReviewCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm' },
      commenter: { login: 'a' },
      args: 'src/missing.js',
      callApi,
    });
    expect(callApi).not.toHaveBeenCalled();
    const body = octokit.__calls.createComment[0].body;
    expect(body).toContain('src/missing.js');
    expect(body).toContain('not part of this PR');
  });

  it('path traversal with .. → rejected, no callApi', async () => {
    const octokit = makeOctokit();
    const callApi = vi.fn();
    await handleReviewCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm' },
      commenter: { login: 'a' },
      args: '../etc/passwd',
      callApi,
    });
    expect(callApi).not.toHaveBeenCalled();
    const body = octokit.__calls.createComment[0].body;
    expect(body).toContain('not a valid file path');
    expect(body).toContain('../etc/passwd');
  });

  it('absolute path → rejected, no callApi', async () => {
    const octokit = makeOctokit();
    const callApi = vi.fn();
    await handleReviewCommand({
      octokit,
      context: makeContext(),
      config: {},
      commenter: { login: 'a' },
      args: '/etc/passwd',
      callApi,
    });
    expect(callApi).not.toHaveBeenCalled();
  });
});

describe('handleReviewCommand — error path', () => {
  it('callApi rejects → short error comment, no throw', async () => {
    const octokit = makeOctokit();
    const core = { info: vi.fn(), warning: vi.fn() };
    const callApi = vi.fn(async () => {
      throw new Error('upstream-500');
    });
    await expect(
      handleReviewCommand({
        octokit,
        context: makeContext(),
        config: { apiKey: 'k', model: 'm' },
        commenter: { login: 'a' },
        args: 'src/a.js',
        callApi,
        core,
      }),
    ).resolves.toBeUndefined();
    const body = octokit.__calls.createComment[0].body;
    expect(body).toContain('Z.ai request failed');
    expect(body).not.toContain('upstream-500');
    expect(core.warning).toHaveBeenCalled();
  });
});
