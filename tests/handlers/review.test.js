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
import {
  handleReviewCommand,
  isUnsafePath,
  buildFileReviewPrompt,
} from '../../src/lib/handlers/review.js';

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

  it('L5: passes maxDiffChars=0 (unlimited sentinel) straight through, NOT the 8000 fallback', async () => {
    // Build two files whose combined patches exceed MAX_WHOLE_PR_DIFF_CHARS
    // (8000). With maxDiffChars=0 (unlimited) both files must appear in the
    // prompt; with the buggy 8000 fallback, the second file would be dropped.
    const big = 'x'.repeat(5000);
    const octokit = makeOctokit({
      files: [
        { filename: 'src/big1.js', status: 'modified', patch: big },
        { filename: 'src/big2.js', status: 'modified', patch: big },
      ],
    });
    const callApi = vi.fn(async () => 'REVIEW');

    await handleReviewCommand({
      octokit,
      context: makeContext(),
      // maxDiffChars: 0 explicitly means "unlimited" per config.js.
      config: { apiKey: 'k', model: 'm', maxDiffChars: 0 },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });

    expect(callApi).toHaveBeenCalledTimes(1);
    const prompt = callApi.mock.calls[0][2];
    // Both large files present (no truncation) — proves the 0 sentinel was
    // passed through rather than being replaced by the 8000 fallback.
    expect(prompt).toContain('src/big1.js');
    expect(prompt).toContain('src/big2.js');
    expect(prompt).toContain(big);
  });
});

/* ------------------------------------------------------------------ *
 * W15-A8-8: whole-PR branch honors EXCLUDE_PATTERNS
 *
 * The whole-PR `/zai review` branch applied only filterPatchableFiles and
 * ignored config.excludePatterns — a lockfile-only PR got reviewed despite
 * the default excludes, while the auto-review path drops those files. The
 * handler must filter excluded files BEFORE filtering patchable ones
 * (mirroring index.js). NOTE: .zai.yml path_filters are merged into the
 * repoConfig locally inside index.js run() and are not reachable from the
 * comment-handler dispatch; action-level excludePatterns are applied here.
 * ------------------------------------------------------------------ */

describe('handleReviewCommand — W15-A8-8: excludes applied on whole-PR path', () => {
  it('lockfile-only PR with default excludes → "No textual changes" note, no callApi', async () => {
    const octokit = makeOctokit({
      files: [{ filename: 'package-lock.json', status: 'modified', patch: '+lockdata' }],
    });
    const callApi = vi.fn();

    await handleReviewCommand({
      octokit,
      context: makeContext(),
      // The default EXCLUDE_PATTERNS from config.js.
      config: {
        apiKey: 'k',
        model: 'm',
        excludePatterns: ['*.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'],
      },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });

    expect(callApi).not.toHaveBeenCalled();
    expect(octokit.__calls.createComment).toHaveLength(1);
    expect(octokit.__calls.createComment[0].body).toContain('No textual changes');
  });

  it('a non-excluded .js file is still reviewed when excludes are set', async () => {
    const octokit = makeOctokit({
      files: [
        { filename: 'package-lock.json', status: 'modified', patch: '+lockdata' },
        { filename: 'src/a.js', status: 'modified', patch: '+a' },
      ],
    });
    const callApi = vi.fn(async () => 'REVIEW');

    await handleReviewCommand({
      octokit,
      context: makeContext(),
      config: {
        apiKey: 'k',
        model: 'm',
        maxDiffChars: 0,
        excludePatterns: ['*.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'],
      },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });

    expect(callApi).toHaveBeenCalledTimes(1);
    const prompt = callApi.mock.calls[0][2];
    expect(prompt).toContain('src/a.js');
    expect(prompt).not.toContain('package-lock.json');
    expect(octokit.__calls.createComment[0].body).toContain('REVIEW');
  });

  it('no excludePatterns configured → behavior unchanged (all patchable reviewed)', async () => {
    const octokit = makeOctokit({
      files: [{ filename: 'package-lock.json', status: 'modified', patch: '+lockdata' }],
    });
    const callApi = vi.fn(async () => 'REVIEW');

    await handleReviewCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm' },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });

    expect(callApi).toHaveBeenCalledTimes(1);
    expect(callApi.mock.calls[0][2]).toContain('package-lock.json');
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

/* ------------------------------------------------------------------ *
 * W16-B4-3: the single-file path caps the patch
 *
 * buildFileReviewPrompt interpolated file.patch raw with NO cap — a
 * 3000-line file produced a ~104k-char prompt, unlike the whole-PR path
 * (MAX_WHOLE_PR_DIFF_CHARS = 8000, overridable by config.maxDiffChars
 * where 0 = unlimited). The single-file patch must be capped with the SAME
 * resolution and marked when truncated.
 * ------------------------------------------------------------------ */

describe('handleReviewCommand — W16-B4-3: single-file diff cap', () => {
  const longPatch = () =>
    Array.from({ length: 3000 }, (_, i) => `+line ${i + 1}`).join('\n');

  it('buildFileReviewPrompt: a 3000-line patch is truncated with a marker (default 8000 cap)', () => {
    const prompt = buildFileReviewPrompt({
      filename: 'src/big.js',
      status: 'modified',
      patch: longPatch(),
    });
    expect(prompt).toContain('diff truncated');
    // The tail of the raw patch is NOT present (only the capped prefix is).
    expect(prompt).not.toContain('line 3000');
    expect(prompt.length).toBeLessThan(10000);
  });

  it('buildFileReviewPrompt: a small patch is included unchanged (no marker)', () => {
    const prompt = buildFileReviewPrompt({
      filename: 'src/a.js',
      status: 'modified',
      patch: '+a\n+b',
    });
    expect(prompt).toContain('+a\n+b');
    expect(prompt).not.toContain('diff truncated');
  });

  it('buildFileReviewPrompt: maxDiffChars 0 (unlimited sentinel) disables truncation, mirroring the whole-PR path', () => {
    const prompt = buildFileReviewPrompt(
      { filename: 'src/big.js', status: 'modified', patch: longPatch() },
      { maxDiffChars: 0 },
    );
    expect(prompt).toContain('line 3000');
    expect(prompt).not.toContain('diff truncated');
  });

  it('handler: explicit-file review of a huge patch is capped via the same config resolution', async () => {
    const octokit = makeOctokit({
      files: [{ filename: 'src/big.js', status: 'modified', patch: longPatch() }],
    });
    const callApi = vi.fn(async () => 'FILE-REVIEW');

    await handleReviewCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm' },
      commenter: { login: 'a' },
      args: 'src/big.js',
      callApi,
    });

    expect(callApi).toHaveBeenCalledTimes(1);
    const prompt = callApi.mock.calls[0][2];
    expect(prompt).toContain('diff truncated');
    expect(prompt).not.toContain('line 3000');
  });

  it('handler: explicit-file review of a default-excluded file still reviews it (intended)', async () => {
    // Excludes only apply to the whole-PR/auto paths; an EXPLICIT
    // `/zai review package-lock.json` must keep working.
    const octokit = makeOctokit({
      files: [
        { filename: 'package-lock.json', status: 'modified', patch: '+lockdata' },
      ],
    });
    const callApi = vi.fn(async () => 'FILE-REVIEW');

    await handleReviewCommand({
      octokit,
      context: makeContext(),
      config: {
        apiKey: 'k',
        model: 'm',
        excludePatterns: ['*.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'],
      },
      commenter: { login: 'a' },
      args: 'package-lock.json',
      callApi,
    });

    expect(callApi).toHaveBeenCalledTimes(1);
    expect(callApi.mock.calls[0][2]).toContain('package-lock.json');
    expect(callApi.mock.calls[0][2]).toContain('+lockdata');
    expect(octokit.__calls.createComment[0].body).toContain('FILE-REVIEW');
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

/* ------------------------------------------------------------------ *
 * isUnsafePath — path-traversal guard (Task 11 edge cases)
 *
 * The guard rejects any path containing ".." or starting with "/". It is a
 * deliberately blunt substring check: it false-positives on legitimate
 * filenames that happen to contain "..", trading convenience for safety.
 * ------------------------------------------------------------------ */

describe('isUnsafePath — traversal & absolute paths rejected (edge cases)', () => {
  it('"../../etc/passwd" → true (unsafe)', () => {
    expect(isUnsafePath('../../etc/passwd')).toBe(true);
  });

  it('"/etc/passwd" → true (unsafe: leading slash)', () => {
    expect(isUnsafePath('/etc/passwd')).toBe(true);
  });
});

describe('isUnsafePath — safe paths (edge cases)', () => {
  it('"src/app.js" → false (safe)', () => {
    expect(isUnsafePath('src/app.js')).toBe(false);
  });

  it('"src/lib/utils.js" → false (safe with subdirectory)', () => {
    expect(isUnsafePath('src/lib/utils.js')).toBe(false);
  });
});

describe('isUnsafePath — ".." traversal detection (path-segment aware)', () => {
  it('"my..file.js" → false (safe: ".." inside a filename is NOT traversal)', () => {
    // FIX: Only ".." used as a PATH SEGMENT (../ or /.. or ^..) is traversal.
    // Double dots inside a filename (my..file.js, v1..0.js) are legitimate.
    expect(isUnsafePath('my..file.js')).toBe(false);
  });

  it('"src/../etc/passwd" → true (unsafe: mid-path traversal)', () => {
    expect(isUnsafePath('src/../etc/passwd')).toBe(true);
  });

  it('"../../etc/passwd" → true (unsafe: leading traversal)', () => {
    expect(isUnsafePath('../../etc/passwd')).toBe(true);
  });

  it('"src/.." → true (unsafe: trailing traversal segment)', () => {
    expect(isUnsafePath('src/..')).toBe(true);
  });

  it('"../config" → true (unsafe: leading traversal segment)', () => {
    expect(isUnsafePath('../config')).toBe(true);
  });
});

describe('isUnsafePath — null byte & empty input (edge cases)', () => {
  it('empty string → true (unsafe: treated as invalid input)', () => {
    expect(isUnsafePath('')).toBe(true);
  });

  it('null byte in path → true (unsafe: control characters rejected)', () => {
    // FIX: Embedded null bytes are rejected. Null bytes can truncate strings
    // in C-based downstream tools and are never legitimate in file paths.
    expect(isUnsafePath('src\x00app.js')).toBe(true);
  });

  it('non-string input → true (unsafe)', () => {
    expect(isUnsafePath(undefined)).toBe(true);
    expect(isUnsafePath(null)).toBe(true);
    expect(isUnsafePath(42)).toBe(true);
  });
});
