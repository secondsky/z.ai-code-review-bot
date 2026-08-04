/**
 * Tests for src/lib/handlers/impact.js — assess impact/risk.
 *
 * READ-ONLY by default: the assessment is posted as a COMMENT only; NO labels
 * are applied unless ZAI_IMPACT_LABELS is on. These tests assert both the
 * default read-only path and the opt-in label-application feature.
 */
import { describe, it, expect, vi } from 'vitest';
import { handleImpactCommand, parseSeverity } from '../../src/lib/handlers/impact.js';

function makeOctokit({
  files = [
    { filename: 'src/a.js', status: 'modified', patch: 'patch-a' },
    { filename: 'auth/login.js', status: 'modified', patch: 'patch-b' },
  ],
  labels = [],
} = {}) {
  const calls = {
    createComment: [],
    listFiles: [],
    addLabels: [],
    listLabels: [],
    removeLabel: [],
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
        async listLabelsOnIssue(params) {
          calls.listLabels.push(params);
          return { data: labels };
        },
        async removeLabel(params) {
          calls.removeLabel.push(params);
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
  it('NEVER calls issues.addLabels when impactLabels is off (default)', async () => {
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

describe('parseSeverity', () => {
  it('extracts critical from the emoji prefix', () => {
    expect(parseSeverity('🔴 critical\nbig blast radius')).toBe('critical');
  });
  it('extracts high/medium/low from emoji prefixes', () => {
    expect(parseSeverity('🟠 high\n...')).toBe('high');
    expect(parseSeverity('🟡 medium\n...')).toBe('medium');
    expect(parseSeverity('🟢 low\n...')).toBe('low');
  });
  it('falls back to word-form if no emoji', () => {
    expect(parseSeverity('Severity: critical\n...')).toBe('critical');
    expect(parseSeverity('this is HIGH risk')).toBe('high');
  });
  it('returns null when no severity keyword is present', () => {
    expect(parseSeverity('Some generic assessment without a level.')).toBeNull();
  });
});

describe('handleImpactCommand — ZAI_IMPACT_LABELS (opt-in label application)', () => {
  const labelMap = {
    critical: 'zai:critical', high: 'zai:high', medium: 'zai:medium', low: 'zai:low',
  };

  it('applies the mapped zai: label for a critical assessment', async () => {
    const octokit = makeOctokit({ labels: [] });
    const callApi = vi.fn(async () => '🔴 critical\nhuge blast radius');
    await handleImpactCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm', impactLabels: true, impactLabelMap: labelMap },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });
    expect(octokit.__calls.addLabels).toHaveLength(1);
    expect(octokit.__calls.addLabels[0].labels).toEqual(['zai:critical']);
  });

  it('removes a prior zai: label before setting the new one (idempotent)', async () => {
    const octokit = makeOctokit({ labels: [{ name: 'zai:medium' }, { name: 'bug' }] });
    const callApi = vi.fn(async () => '🔴 critical\n...');
    await handleImpactCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm', impactLabels: true, impactLabelMap: labelMap },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });
    // The old zai:medium label was removed...
    expect(octokit.__calls.removeLabel).toHaveLength(1);
    expect(octokit.__calls.removeLabel[0].name).toBe('zai:medium');
    // ...and the new zai:critical label was added.
    expect(octokit.__calls.addLabels[0].labels).toEqual(['zai:critical']);
  });

  it('does NOT touch non-zai (human) labels', async () => {
    const octokit = makeOctokit({ labels: [{ name: 'bug' }, { name: 'priority' }] });
    const callApi = vi.fn(async () => '🟢 low');
    await handleImpactCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm', impactLabels: true, impactLabelMap: labelMap },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });
    // Neither human label was removed.
    expect(octokit.__calls.removeLabel).toHaveLength(0);
    expect(octokit.__calls.addLabels[0].labels).toEqual(['zai:low']);
  });

  it('does NOT apply a label when severity is unmappable (graceful)', async () => {
    const octokit = makeOctokit();
    const callApi = vi.fn(async () => 'No severity keyword here.');
    await handleImpactCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm', impactLabels: true, impactLabelMap: labelMap },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });
    expect(octokit.__calls.addLabels).toHaveLength(0);
    // The assessment was still posted as a comment.
    expect(octokit.__calls.createComment).toHaveLength(1);
  });

  it('does NOT apply labels when impactLabels is false even with a clear severity', async () => {
    const octokit = makeOctokit();
    const callApi = vi.fn(async () => '🔴 critical');
    await handleImpactCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm', impactLabels: false, impactLabelMap: labelMap },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });
    expect(octokit.__calls.addLabels).toHaveLength(0);
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
