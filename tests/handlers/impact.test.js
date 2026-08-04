/**
 * Tests for src/lib/handlers/impact.js — assess impact/risk.
 *
 * v1 is READ-ONLY: the assessment is posted as a COMMENT only; NO labels are
 * ever applied (no issues.addLabels). These tests assert both the happy path
 * and the read-only invariant.
 */
import { describe, it, expect, vi } from 'vitest';
import { handleImpactCommand } from '../../src/lib/handlers/impact.js';

function makeOctokit({
  files = [
    { filename: 'src/a.js', status: 'modified', patch: 'patch-a' },
    { filename: 'auth/login.js', status: 'modified', patch: 'patch-b' },
  ],
} = {}) {
  const calls = {
    createComment: [],
    listFiles: [],
    addLabels: [], // MUST stay empty (read-only).
  };
  const octokit = {
    rest: {
      issues: {
        async createComment(params) {
          calls.createComment.push(params);
          return { data: { id: 1 } };
        },
        async addLabels(params) {
          calls.addLabels.push(params);
          return { data: {} };
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

describe('handleImpactCommand — success', () => {
  it('calls callApi once with a risk-assessment prompt and posts the result', async () => {
    const octokit = makeOctokit();
    const callApi = vi.fn(async () => '## Impact: 🟡 medium\n...');

    await handleImpactCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm' },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });

    expect(callApi).toHaveBeenCalledTimes(1);
    const prompt = callApi.mock.calls[0][2];
    // Risk-assessment framing + severity levels.
    expect(prompt.toLowerCase()).toContain('risk');
    expect(prompt).toContain('🟢');
    expect(prompt).toContain('🟡');
    expect(prompt).toContain('🟠');
    expect(prompt).toContain('🔴');
    // Diffs fed in.
    expect(prompt).toContain('src/a.js');
    expect(prompt).toContain('auth/login.js');
    // Result posted.
    expect(octokit.__calls.createComment[0].body).toContain('Impact');
  });
});

describe('handleImpactCommand — read-only invariant', () => {
  it('NEVER calls issues.addLabels (does not apply labels)', async () => {
    const octokit = makeOctokit();
    const callApi = vi.fn(async () => 'impact');
    await handleImpactCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm' },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });
    expect(octokit.__calls.addLabels).toHaveLength(0);
    expect(octokit.__calls.createComment).toHaveLength(1);
  });
});

describe('handleImpactCommand — error path', () => {
  it('callApi rejects → short error comment, no throw', async () => {
    const octokit = makeOctokit();
    const core = { info: vi.fn(), warning: vi.fn() };
    const callApi = vi.fn(async () => {
      throw new Error('timeout');
    });
    await expect(
      handleImpactCommand({
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
    expect(body).not.toContain('timeout');
    expect(core.warning).toHaveBeenCalled();
  });
});
