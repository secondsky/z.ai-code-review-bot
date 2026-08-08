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
  pr = { body: '' },
} = {}) {
  const calls = {
    createComment: [],
    listCommits: [],
    listFiles: [],
    get: [],
    update: [], // MUST stay empty unless ZAI_DESCRIBE_WRITE_BODY is on.
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
        async get(params) {
          calls.get.push(params);
          return { data: pr };
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
  it('NEVER calls pulls.update when describeWriteBody is off (default)', async () => {
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

describe('handleDescribeCommand — ZAI_DESCRIBE_WRITE_BODY (opt-in body upsert)', () => {
  it('upserts a marked block into an EMPTY PR body when enabled', async () => {
    const octokit = makeOctokit({ pr: { body: '' } });
    const callApi = vi.fn(async () => '## Overview\nNew feature.');
    await handleDescribeCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm', describeWriteBody: true },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });
    expect(octokit.__calls.update).toHaveLength(1);
    const newBody = octokit.__calls.update[0].body;
    expect(newBody).toContain('<!-- zai-description -->');
    expect(newBody).toContain('## Overview\nNew feature.');
    expect(newBody).toContain('<!-- /zai-description -->');
  });

  it('appends the marked block to a NON-empty body, preserving the original text', async () => {
    const octokit = makeOctokit({ pr: { body: '## Notes\nfix for #42' } });
    const callApi = vi.fn(async () => '## Overview\nDesc.');
    await handleDescribeCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm', describeWriteBody: true },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });
    const newBody = octokit.__calls.update[0].body;
    expect(newBody).toContain('## Notes\nfix for #42');
    expect(newBody).toContain('<!-- zai-description -->');
  });

  it('replaces ONLY the marked block on re-runs (idempotent), preserving surrounding text', async () => {
    const existingBody =
      '## Notes\nold notes\n\n<!-- zai-description -->\nOLD DESC\n<!-- /zai-description -->\n\n## Checklist\n- [ ] x';
    const octokit = makeOctokit({ pr: { body: existingBody } });
    const callApi = vi.fn(async () => 'NEW DESC');
    await handleDescribeCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm', describeWriteBody: true },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });
    const newBody = octokit.__calls.update[0].body;
    // Surrounding text preserved.
    expect(newBody).toContain('## Notes\nold notes');
    expect(newBody).toContain('## Checklist\n- [ ] x');
    // Block contents replaced.
    expect(newBody).toContain('NEW DESC');
    expect(newBody).not.toContain('OLD DESC');
    // Exactly one start/end marker pair (no duplication).
    expect(newBody.match(/<!-- zai-description -->/g).length).toBe(1);
    expect(newBody.match(/<!-- \/zai-description -->/g).length).toBe(1);
  });

  it('does NOT mutate the body when describeWriteBody is false even if a block exists', async () => {
    const octokit = makeOctokit();
    const callApi = vi.fn(async () => 'desc');
    await handleDescribeCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm', describeWriteBody: false },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });
    expect(octokit.__calls.update).toHaveLength(0);
  });
});

describe('handleDescribeCommand — H1/M3 sanitization of model output', () => {
  it('sanitizes @mentions in the description before posting it as a comment', async () => {
    const octokit = makeOctokit();
    // Raw model output containing an @mention that the sanitizer must break
    // (zero-width space inserted after the @) so GitHub won't trigger a ping.
    const callApi = vi.fn(async () => 'Hey @everyone look here');
    await handleDescribeCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm' },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });
    const body = octokit.__calls.createComment[0].body;
    // The raw mention trigger must NOT appear.
    expect(body).not.toContain('@everyone');
    // Sanitized form: @ + zero-width space + everyone.
    expect(body).toContain('@\u200beveryone');
  });

  it('sanitizes @mentions in the description before upserting the PR body (ZAI_DESCRIBE_WRITE_BODY)', async () => {
    const octokit = makeOctokit({ pr: { body: '' } });
    const callApi = vi.fn(async () => 'Ping @evil-org/security-team now');
    await handleDescribeCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm', describeWriteBody: true },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });
    expect(octokit.__calls.update).toHaveLength(1);
    const newBody = octokit.__calls.update[0].body;
    // Raw mention must NOT reach pulls.update.
    expect(newBody).not.toContain('@evil-org/security-team');
    expect(newBody).toContain('@\u200bevil-org/security-team');
  });

  it('caps overly-long model output before upserting the PR body (M3: avoids GitHub 422)', async () => {
    const octokit = makeOctokit({ pr: { body: '' } });
    // 70000 chars of 'a' — well over GitHub's 65536 PR-body limit and over
    // sanitizeModelOutput's 16000 cap. The sanitizer must truncate it.
    const huge = 'a'.repeat(70000);
    const callApi = vi.fn(async () => huge);
    await handleDescribeCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm', describeWriteBody: true },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });
    const newBody = octokit.__calls.update[0].body;
    // Must be well under the 65536 limit after sanitization.
    expect(newBody.length).toBeLessThan(65536);
    expect(newBody).toContain('truncated by Z.ai safety filter');
  });

  it('caps overly-long model output before posting as a comment', async () => {
    const octokit = makeOctokit();
    const huge = 'a'.repeat(70000);
    const callApi = vi.fn(async () => huge);
    await handleDescribeCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm' },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });
    const body = octokit.__calls.createComment[0].body;
    expect(body.length).toBeLessThan(65536);
    expect(body).toContain('truncated by Z.ai safety filter');
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
