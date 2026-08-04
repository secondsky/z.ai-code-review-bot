/**
 * Tests for src/lib/handlers/explain.js — explain a line range.
 *
 * Covers:
 *  - parseRange: N-M, N:M, N..M, single N; invalid (non-numeric, end<start).
 *  - valid range + file → explains; callApi prompt contains the line window.
 *  - invalid range → guidance, no callApi.
 *  - empty args → usage guidance, no callApi.
 *  - file not in PR → guidance.
 *  - callApi rejects → short error comment, no throw.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  handleExplainCommand,
  parseRange,
  parseExplainArgs,
} from '../../src/lib/handlers/explain.js';

// Helper: encode plain text as the GitHub API would (base64).
function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function makeOctokit({
  files = [{ filename: 'src/a.js', status: 'modified', patch: '+a\n+b\n+c' }],
  content = { content: b64('line1\nline2\nline3\nline4\nline5') },
} = {}) {
  const calls = { createComment: [], listFiles: [], getContent: [] };
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
      repos: {
        async getContent(params) {
          calls.getContent.push(params);
          return { data: content };
        },
      },
    },
  };
  octokit.__calls = calls;
  return octokit;
}

function makeContext({ number = 42, headSha = 'sha-head' } = {}) {
  return {
    repo: { owner: 'owner', repo: 'repo' },
    payload: { issue: { number }, pull_request: { head: { sha: headSha } } },
  };
}

/* ------------------------------------------------------------------ *
 * parseRange (pure)
 * ------------------------------------------------------------------ */

describe('parseRange', () => {
  it.each([
    ['10-20', { start: 10, end: 20 }],
    ['10:20', { start: 10, end: 20 }],
    ['10..20', { start: 10, end: 20 }],
    ['5', { start: 5, end: 5 }],
  ])('parses %s → %o', (input, expected) => {
    expect(parseRange(input)).toEqual(expected);
  });

  it.each([['abc'], ['10-'], ['-20'], ['10-5'], ['5-2'], [''], ['  '], ['10--20']])(
    'rejects invalid range %s',
    (input) => {
      expect(parseRange(input)).toBeNull();
    },
  );

  it('rejects non-string input', () => {
    expect(parseRange(undefined)).toBeNull();
    expect(parseRange(42)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * parseExplainArgs (pure) — splits "10-20 [file]"
 * ------------------------------------------------------------------ */

describe('parseExplainArgs', () => {
  it('parses range + file', () => {
    expect(parseExplainArgs('10-20 src/a.js')).toEqual({
      range: { start: 10, end: 20 },
      file: 'src/a.js',
    });
  });

  it('parses range only', () => {
    expect(parseExplainArgs('10-20')).toEqual({
      range: { start: 10, end: 20 },
      file: null,
    });
  });

  it('returns null range when the range is invalid', () => {
    expect(parseExplainArgs('foo')).toEqual({ range: null, file: null });
  });

  it('returns null range when empty', () => {
    expect(parseExplainArgs('')).toEqual({ range: null, file: null });
    expect(parseExplainArgs('   ')).toEqual({ range: null, file: null });
  });
});

/* ------------------------------------------------------------------ *
 * handler
 * ------------------------------------------------------------------ */

describe('handleExplainCommand — guidance', () => {
  it('empty args → usage guidance, no callApi', async () => {
    const octokit = makeOctokit();
    const callApi = vi.fn();
    await handleExplainCommand({
      octokit,
      context: makeContext(),
      config: {},
      commenter: { login: 'a' },
      args: '',
      callApi,
    });
    expect(callApi).not.toHaveBeenCalled();
    const body = octokit.__calls.createComment[0].body;
    expect(body).toContain('/zai explain');
    expect(body).toContain('Usage');
  });

  it('invalid range → usage guidance, no callApi', async () => {
    const octokit = makeOctokit();
    const callApi = vi.fn();
    await handleExplainCommand({
      octokit,
      context: makeContext(),
      config: {},
      commenter: { login: 'a' },
      args: 'abc',
      callApi,
    });
    expect(callApi).not.toHaveBeenCalled();
    expect(octokit.__calls.createComment[0].body).toContain('Usage');
  });
});

describe('handleExplainCommand — success', () => {
  it('valid range + explicit file → explains the line window', async () => {
    const octokit = makeOctokit({
      content: { content: b64('l1\nl2\nl3\nl4\nl5') },
    });
    const callApi = vi.fn(async () => 'EXPLANATION');

    await handleExplainCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm' },
      commenter: { login: 'a' },
      args: '2-4 src/a.js',
      callApi,
    });

    expect(callApi).toHaveBeenCalledTimes(1);
    const prompt = callApi.mock.calls[0][2];
    expect(prompt).toContain('src/a.js');
    expect(prompt).toContain('l2');
    expect(prompt).toContain('l4');
    // No out-of-window lines leaked in.
    expect(prompt).not.toContain('l5');
    expect(octokit.__calls.createComment[0].body).toContain('EXPLANATION');
    // Fetched at the PR head sha.
    expect(octokit.__calls.getContent[0]).toMatchObject({
      owner: 'owner',
      repo: 'repo',
      path: 'src/a.js',
      ref: 'sha-head',
    });
  });

  it('no file arg → uses the first changed file', async () => {
    const octokit = makeOctokit({
      files: [{ filename: 'src/first.js', status: 'modified', patch: '+x' }],
      content: { content: b64('only-line') },
    });
    const callApi = vi.fn(async () => 'EX');

    await handleExplainCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm' },
      commenter: { login: 'a' },
      args: '1',
      callApi,
    });

    expect(callApi).toHaveBeenCalledTimes(1);
    expect(callApi.mock.calls[0][2]).toContain('src/first.js');
  });

  it('explicit file not in PR → guidance, no callApi', async () => {
    const octokit = makeOctokit();
    const callApi = vi.fn();
    await handleExplainCommand({
      octokit,
      context: makeContext(),
      config: {},
      commenter: { login: 'a' },
      args: '1-2 src/missing.js',
      callApi,
    });
    expect(callApi).not.toHaveBeenCalled();
    expect(octokit.__calls.createComment[0].body).toContain('src/missing.js');
  });

  it('no changed files at all and no file arg → guidance, no callApi', async () => {
    const octokit = makeOctokit({ files: [] });
    const callApi = vi.fn();
    await handleExplainCommand({
      octokit,
      context: makeContext(),
      config: {},
      commenter: { login: 'a' },
      args: '1-2',
      callApi,
    });
    expect(callApi).not.toHaveBeenCalled();
    expect(octokit.__calls.createComment[0].body).toContain('Usage');
  });
});

describe('handleExplainCommand — error path', () => {
  it('callApi rejects → short error comment, no throw', async () => {
    const octokit = makeOctokit();
    const core = { info: vi.fn(), warning: vi.fn() };
    const callApi = vi.fn(async () => {
      throw new Error('down');
    });
    await expect(
      handleExplainCommand({
        octokit,
        context: makeContext(),
        config: { apiKey: 'k', model: 'm' },
        commenter: { login: 'a' },
        args: '1-2 src/a.js',
        callApi,
        core,
      }),
    ).resolves.toBeUndefined();
    const body = octokit.__calls.createComment[0].body;
    expect(body).toContain('Z.ai request failed');
    expect(body).not.toContain('down');
    expect(core.warning).toHaveBeenCalled();
  });
});
