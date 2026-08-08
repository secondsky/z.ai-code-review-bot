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
  headSha = 'sha-head',
} = {}) {
  const calls = { createComment: [], listFiles: [], getContent: [], pullsGet: [] };
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
        async get(params) {
          calls.pullsGet.push(params);
          return {
            data: {
              title: 'Test PR',
              body: '',
              head: { ref: 'feature', sha: headSha },
              base: { ref: 'main' },
            },
          };
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

// Real `issue_comment` payload shape: there is NO top-level pull_request, only
// the minimal `payload.issue.pull_request` reference (which carries a `url`
// but no `head.sha`). The head SHA is supplied via the mocked pulls.get.
function makeContext({ number = 42 } = {}) {
  return {
    repo: { owner: 'owner', repo: 'repo' },
    payload: {
      issue: {
        number,
        title: 'Test PR',
        body: '',
        pull_request: { url: `https://api.github.com/repos/owner/repo/pulls/${number}` },
      },
      comment: { id: 100, body: '', user: { login: 'a' }, author_association: 'COLLABORATOR' },
      sender: { login: 'a', author_association: 'COLLABORATOR' },
    },
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
    // The head SHA was fetched via pulls.get (NOT read from the payload, which
    // does not carry it for issue_comment events).
    expect(octokit.__calls.pullsGet[0]).toMatchObject({
      owner: 'owner',
      repo: 'repo',
      pull_number: 42,
    });
    // Fetched at the PR head sha returned by pulls.get.
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

  it('clamps a huge range to the MAX_WINDOW_LINES cap (cost guard)', async () => {
    // A 10000-line file with a `/zai explain 1-10000` request. Without the cap
    // the whole file would go into the prompt; the cap limits the window.
    const lines = Array.from({ length: 10000 }, (_, i) => `line${i + 1}`);
    const octokit = makeOctokit({
      content: { content: b64(lines.join('\n')) },
    });
    const callApi = vi.fn(async () => 'EX');

    await handleExplainCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm' },
      commenter: { login: 'a' },
      args: '1-10000 src/a.js',
      callApi,
    });

    expect(callApi).toHaveBeenCalledTimes(1);
    const prompt = callApi.mock.calls[0][2];
    // The first 400 lines are within the window; line 401 is NOT.
    expect(prompt).toContain('line1');
    expect(prompt).toContain('line400');
    expect(prompt).not.toContain('line401');
    // The reported range reflects the clamp.
    expect(prompt).toContain('1-400');
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

/* ------------------------------------------------------------------ *
 * parseRange — edge cases (Task 11)
 *
 * These pin behavior for the three supported separators, the single-line
 * form, start<1 rejection, and non-numeric/reversed inputs. They overlap
 * the table-driven cases above intentionally to name each invariant.
 * ------------------------------------------------------------------ */

describe('parseRange — separator forms (edge cases)', () => {
  it('`..` separator: "10..20" → {start:10, end:20}', () => {
    expect(parseRange('10..20')).toEqual({ start: 10, end: 20 });
  });

  it('`-` separator: "10-20" → {start:10, end:20}', () => {
    expect(parseRange('10-20')).toEqual({ start: 10, end: 20 });
  });

  it('`:` separator: "10:20" → {start:10, end:20}', () => {
    expect(parseRange('10:20')).toEqual({ start: 10, end: 20 });
  });

  it('single line: "10" → {start:10, end:10}', () => {
    expect(parseRange('10')).toEqual({ start: 10, end: 10 });
  });

  it('whitespace is trimmed: "  10-20  " → {start:10, end:20}', () => {
    expect(parseRange('  10-20  ')).toEqual({ start: 10, end: 20 });
  });
});

describe('parseRange — start < 1 is rejected (edge cases)', () => {
  it('"0-10" → null (start is zero)', () => {
    // The check `start < 1` rejects zero as a valid line number.
    expect(parseRange('0-10')).toBeNull();
  });

  it('"-5" → null (looks like a negative range; parses left="" → 0)', () => {
    // NOTE: Number("") === 0 and Number.isInteger(0) === true, so the left
    // side parses to 0; the `start < 1` guard then rejects it. This pins the
    // behavior rather than relying on a throw.
    expect(parseRange('-5')).toBeNull();
  });

  it('"0" → null (single-line zero)', () => {
    expect(parseRange('0')).toBeNull();
  });
});

describe('parseRange — invalid input (edge cases)', () => {
  it('non-numeric range: "abc" → null', () => {
    expect(parseRange('abc')).toBeNull();
  });

  it('non-numeric side: "10-abc" → null', () => {
    expect(parseRange('10-abc')).toBeNull();
  });

  it('reversed range (start > end): "10-5" → null', () => {
    expect(parseRange('10-5')).toBeNull();
  });

  it('reversed range with `:`: "20:10" → null', () => {
    expect(parseRange('20:10')).toBeNull();
  });

  it('decimal line numbers are rejected: "1.5-2" → null', () => {
    // Number.isInteger(1.5) is false → rejected.
    expect(parseRange('1.5-2')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * parseExplainArgs — file path with spaces (Task 11)
 * ------------------------------------------------------------------ */

describe('parseExplainArgs — file path with spaces (edge cases)', () => {
  it('joins all tokens after the range into the file path', () => {
    // "10-20 my file.js" → file is "my file.js" (tokens joined by space).
    expect(parseExplainArgs('10-20 my file.js')).toEqual({
      range: { start: 10, end: 20 },
      file: 'my file.js',
    });
  });

  it('preserves a subdirectory path containing spaces', () => {
    expect(parseExplainArgs('10-20 src/my file.js')).toEqual({
      range: { start: 10, end: 20 },
      file: 'src/my file.js',
    });
  });

  it('collapses multiple spaces between path tokens', () => {
    // The args are split on /\s+/ then joined with a single space.
    expect(parseExplainArgs('10-20 my    spaced   file.js')).toEqual({
      range: { start: 10, end: 20 },
      file: 'my spaced file.js',
    });
  });
});
