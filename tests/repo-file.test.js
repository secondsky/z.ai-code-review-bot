/**
 * Tests for src/lib/repo-file.js — the shared repo-file loader.
 *
 * `fetchRepoText` owns the fetch + base64-decode + dual-size-cap pipeline that
 * codeowners / learnings / repo-config each used to duplicate (with drifted
 * conventions). It returns an explicit outcome instead of throwing, so every
 * caller can map `missing` / `too-large` / `decode` / `error` onto its own
 * pinned warning shape. `resolveHeadSha` is the verbatim head-SHA resolver the
 * three loaders previously copied.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchRepoText, resolveHeadSha } from '../src/lib/repo-file.js';

/** Build a fake octokit whose repos.getContent returns `resp` (or throws). */
function makeOctokit(responder) {
  return {
    rest: {
      repos: {
        async getContent(params) {
          return responder(params);
        },
      },
    },
  };
}

/** Base args for fetchRepoText (single call site defaults). */
function baseArgs(overrides = {}) {
  return {
    owner: 'owner',
    repo: 'repo',
    path: 'CODEOWNERS',
    ref: 'abcdef1234567890',
    maxBytes: 1024,
    label: 'test',
    ...overrides,
  };
}

/** A GitHub-shaped file response: `{content, encoding}` (+ optional `size`). */
function fileResponse(text, size) {
  const data = { content: Buffer.from(text, 'utf8').toString('base64'), encoding: 'base64' };
  if (typeof size === 'number') data.size = size;
  return { data };
}

describe('fetchRepoText — outcome kinds', () => {
  it('404 → { ok: false, kind: "missing" }', async () => {
    const octokit = makeOctokit(() => {
      const err = new Error('Not Found');
      err.status = 404;
      throw err;
    });
    const out = await fetchRepoText(baseArgs({ octokit }));
    expect(out).toEqual({
      ok: false,
      kind: 'missing',
      message: expect.stringMatching(/404/),
    });
  });

  it('non-404 rejection → { ok: false, kind: "error" }', async () => {
    const octokit = makeOctokit(() => {
      const err = new Error('Server Error');
      err.status = 500;
      throw err;
    });
    const out = await fetchRepoText(baseArgs({ octokit }));
    expect(out).toEqual({
      ok: false,
      kind: 'error',
      message: expect.stringMatching(/500[\s\S]*Server Error/),
    });
  });

  it('data.size > maxBytes → { ok: false, kind: "too-large" } (byte cap)', async () => {
    const octokit = makeOctokit(() => fileResponse('hello', 4096));
    const out = await fetchRepoText(baseArgs({ octokit }));
    expect(out.ok).toBe(false);
    expect(out.kind).toBe('too-large');
    expect(out.message).toMatch(/4096 bytes/);
    expect(out.message).toMatch(/cap 1024/);
  });

  it('decoded length > maxBytes → { ok: false, kind: "too-large" } (post-decode cap)', async () => {
    // `data.size` lies (5) but the decoded text is 200 chars > maxBytes 100 —
    // only the post-decode guard catches this.
    const octokit = makeOctokit(() => fileResponse('x'.repeat(200), 5));
    const out = await fetchRepoText(baseArgs({ octokit, maxBytes: 100 }));
    expect(out.ok).toBe(false);
    expect(out.kind).toBe('too-large');
    expect(out.message).toMatch(/decodes to 200 chars/);
    expect(out.message).toMatch(/cap 100/);
  });

  it('base64 decode failure → { ok: false, kind: "decode" }', async () => {
    // Precompute the response BEFORE mocking Buffer.from (the mock must only
    // intercept the decode call inside fetchRepoText, not response building).
    const resp = fileResponse('hello');
    const spy = vi
      .spyOn(Buffer, 'from')
      .mockImplementation(() => {
        throw new Error('bad base64');
      });
    const octokit = makeOctokit(() => resp);
    try {
      const out = await fetchRepoText(baseArgs({ octokit }));
      expect(out.ok).toBe(false);
      expect(out.kind).toBe('decode');
      expect(out.message).toMatch(/base64-decoded/);
    } finally {
      spy.mockRestore();
    }
  });

  it('happy path (base64 content, whitespace tolerated) → { ok: true, text }', async () => {
    // GitHub wraps long base64 payloads with line breaks; the pipeline must
    // strip whitespace before decoding.
    const wrapped = Buffer.from('hello world', 'utf8').toString('base64').replace(/(.{4})/, '$1\n');
    const octokit = makeOctokit(() => ({ data: { content: wrapped, encoding: 'base64' } }));
    const out = await fetchRepoText(baseArgs({ octokit }));
    expect(out).toEqual({ ok: true, text: 'hello world' });
  });

  it('raw-string data → { ok: true, text: data } (learnings/repo-config convention, now shared)', async () => {
    const octokit = makeOctokit(() => ({ data: 'raw text payload' }));
    const out = await fetchRepoText(baseArgs({ octokit }));
    expect(out).toEqual({ ok: true, text: 'raw text payload' });
  });

  it('non-file payload (directory listing) → { ok: false, kind: "missing" }', async () => {
    const octokit = makeOctokit(() => ({ data: [{ name: 'a' }, { name: 'b' }] }));
    const out = await fetchRepoText(baseArgs({ octokit }));
    expect(out.ok).toBe(false);
    expect(out.kind).toBe('missing');
  });

  it('label prefixes every message (callers keep their pinned warning shapes)', async () => {
    const octokit = makeOctokit(() => {
      const err = new Error('Not Found');
      err.status = 404;
      throw err;
    });
    const out = await fetchRepoText(baseArgs({ octokit, label: 'learnings' }));
    expect(out.message.startsWith('learnings: ')).toBe(true);
  });

  // A4: an absent/empty label must NOT produce a `undefined: ` (or empty)
  // prefix — the message starts with the path so a caller that wraps it in
  // its own label (codeowners) does not stutter `X: X: path…`.
  it('no label → message has NO prefix (starts with the path, never "undefined: ")', async () => {
    const octokit = makeOctokit(() => fileResponse('hello', 4096));
    const out = await fetchRepoText({
      ...baseArgs({ octokit, path: '.github/CODEOWNERS' }),
      label: undefined,
    });
    expect(out.ok).toBe(false);
    expect(out.kind).toBe('too-large');
    expect(out.message.startsWith('.github/CODEOWNERS is 4096 bytes')).toBe(true);
    expect(out.message).not.toContain('undefined');
  });

  it('fetches via octokit.rest.repos.getContent with the given owner/repo/path/ref', async () => {
    const calls = [];
    const octokit = makeOctokit((params) => {
      calls.push(params);
      return fileResponse('hi');
    });
    await fetchRepoText(
      baseArgs({ octokit, owner: 'o', repo: 'r', path: 'docs/x.yml', ref: 'refs/heads/main' }),
    );
    expect(calls[0]).toEqual({
      owner: 'o',
      repo: 'r',
      path: 'docs/x.yml',
      ref: 'refs/heads/main',
    });
  });
});

describe('resolveHeadSha — verbatim behavior', () => {
  it('prefers an explicit opts.headSha', () => {
    expect(resolveHeadSha({ headSha: 'explicit', context: { payload: { pull_request: { head: { sha: 'payload' } } } } })).toBe('explicit');
  });

  it('falls back to context.payload.pull_request.head.sha', () => {
    expect(resolveHeadSha({ context: { payload: { pull_request: { head: { sha: 'payload' } } } } })).toBe('payload');
  });

  it('treats an empty-string headSha as unset (falls through to the payload)', () => {
    expect(resolveHeadSha({ headSha: '', context: { payload: { pull_request: { head: { sha: 'payload' } } } } })).toBe('payload');
  });

  it('returns "" when neither source yields a string', () => {
    expect(resolveHeadSha({})).toBe('');
    expect(resolveHeadSha({ context: {} })).toBe('');
    expect(resolveHeadSha({ context: { payload: { pull_request: { head: { sha: 123 } } } } })).toBe('');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
