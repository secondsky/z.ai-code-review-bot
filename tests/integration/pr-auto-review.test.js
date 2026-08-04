/**
 * Integration tests: pull_request → auto-review → comment pipeline.
 *
 * These tests drive `run(context, deps)` from `src/index.js` end-to-end through
 * the REAL module wiring: the real `getChangedFiles`, `filterExcludedFiles`,
 * `filterPatchableFiles`, `buildAutoReviewPrompt`, `runAutoReview`, `isLargePr`,
 * `buildCommentBody`, `upsertReviewComment`, and `parseCommand` helpers — only
 * the outermost collaborators (octokit, core, callApi) are faked. This is the
 * full-stack proof that the modules COMPOSE correctly through the router.
 *
 * Matrix (per task-9-brief):
 *   - small PR → callApi once, prompt contains both files' diffs, one upsert
 *   - large PR → runAutoReview path, callApi > once, final comment posted
 *   - idempotent update → existing marker comment updated, not duplicated
 *   - no patchable files → NO callApi, NO upsert (short-circuit, end-to-end)
 *   - excludes applied → excluded file NOT in the review prompt
 *   - callApi failure → propagates out of run (small-PR path)
 */
import { describe, it, expect } from 'vitest';

import { run } from '../../src/index.js';
import { MARKER } from '../../src/lib/comments.js';
import {
  makeConfig,
  makeFakeCore,
  makeFakeOctokit,
  makeFakeCallApi,
  makePRContext,
  file,
} from './helpers.js';

/* ------------------------------------------------------------------ *
 * Small PR
 * ------------------------------------------------------------------ */

describe('integration: pull_request auto-review — small PR', () => {
  it('calls callApi once with a prompt containing both files and posts ONE summary comment', async () => {
    const core = makeFakeCore();
    const octokit = makeFakeOctokit({
      files: [
        file('src/a.js', '@@ -1 +1 @@\n+const a = 1;'),
        file('src/b.js', '@@ -2 +2 @@\n+const b = 2;'),
      ],
    });
    const callApi = makeFakeCallApi('## Review\nlooks good');
    const config = makeConfig();

    await run(makePRContext(), {
      config,
      core,
      octokit,
      callApi,
      // apiClient is unused when callApi is injected directly; pass a stub so
      // buildCallApi never tries to create a real client.
      apiClient: { call: () => Promise.resolve({ success: true, data: '' }) },
    });

    // callApi invoked exactly once with the auto-review prompt.
    expect(callApi).toHaveBeenCalledTimes(1);
    const [apiKey, model, prompt] = callApi.mock.calls[0];
    expect(apiKey).toBe('test-api-key');
    expect(model).toBe('glm-5.2');
    // The prompt contains BOTH files' diffs.
    expect(prompt).toContain('src/a.js');
    expect(prompt).toContain('src/b.js');
    expect(prompt).toContain('const a = 1;');
    expect(prompt).toContain('const b = 2;');

    // ONE summary comment was created (no existing marker comment).
    expect(octokit.__calls.createComment).toHaveLength(1);
    expect(octokit.__calls.updateComment).toHaveLength(0);
    const body = octokit.__calls.createComment[0].body;
    // The body carries the reviewer name (title) and the hidden MARKER.
    expect(body).toContain('Z.ai Code Review');
    expect(body).toContain(MARKER);
    expect(body).toContain('looks good');
  });

  it('lists files once and posts to the PR number from the context', async () => {
    const core = makeFakeCore();
    const octokit = makeFakeOctokit({ files: [file('src/a.js')] });
    const callApi = makeFakeCallApi('review');
    const ctx = makePRContext({ number: 77, owner: 'acme', repo: 'widget' });

    await run(ctx, {
      config: makeConfig(),
      core,
      octokit,
      callApi,
      apiClient: { call: () => Promise.resolve({ success: true, data: '' }) },
    });

    // getChangedFiles was called with the right owner/repo/pull_number.
    expect(octokit.__calls.listFiles).toHaveLength(1);
    expect(octokit.__calls.listFiles[0]).toMatchObject({
      owner: 'acme',
      repo: 'widget',
      pull_number: 77,
    });
    // The comment was posted to the right issue (PR) number.
    expect(octokit.__calls.createComment[0]).toMatchObject({
      owner: 'acme',
      repo: 'widget',
      issue_number: 77,
    });
  });
});

/* ------------------------------------------------------------------ *
 * Large PR
 * ------------------------------------------------------------------ */

describe('integration: pull_request auto-review — large PR', () => {
  it('routes through runAutoReview: callApi called more than once and a comment is posted', async () => {
    const core = makeFakeCore();
    // largePrFileThreshold: 1, with 3 patchable files → isLargePr returns true.
    const config = makeConfig({ largePrFileThreshold: 1 });
    const files = [
      file('src/a.js', '@@ -1 +1 @@\n+a'),
      file('src/b.js', '@@ -1 +1 @@\n+b'),
      file('src/c.js', '@@ -1 +1 @@\n+c'),
    ];
    const octokit = makeFakeOctokit({ files });
    // The fake returns different content for per-batch vs synthesis calls so
    // we can confirm both happened. runAutoReview calls callApi per batch,
    // then once more for synthesis.
    const callApi = makeFakeCallApi((_api, _model, prompt) => {
      if (prompt.includes('senior synthesizer')) return '## Review Summary\nsynthesized';
      return 'batch review';
    });

    await run(makePRContext(), {
      config,
      core,
      octokit,
      callApi,
      apiClient: { call: () => Promise.resolve({ success: true, data: '' }) },
    });

    // The large-PR path makes at least 2 callApi calls (per-batch + synthesis).
    expect(callApi.mock.calls.length).toBeGreaterThan(1);

    // The final comment was posted and carries the synthesized content + marker.
    expect(octokit.__calls.createComment).toHaveLength(1);
    const body = octokit.__calls.createComment[0].body;
    expect(body).toContain('synthesized');
    expect(body).toContain(MARKER);
  });
});

/* ------------------------------------------------------------------ *
 * Idempotent update
 * ------------------------------------------------------------------ */

describe('integration: pull_request auto-review — idempotent update', () => {
  it('updates the existing MARKER comment instead of creating a duplicate', async () => {
    const core = makeFakeCore();
    const oldBody = `## Z.ai Code Review\n\nold review\n\n${MARKER}`;
    const octokit = makeFakeOctokit({
      files: [file('src/a.js')],
      existingComments: [{ id: 555, body: oldBody }],
    });
    const callApi = makeFakeCallApi('fresh review');

    await run(makePRContext(), {
      config: makeConfig(),
      core,
      octokit,
      callApi,
      apiClient: { call: () => Promise.resolve({ success: true, data: '' }) },
    });

    // updateComment used (NOT createComment).
    expect(octokit.__calls.updateComment).toHaveLength(1);
    expect(octokit.__calls.updateComment[0].comment_id).toBe(555);
    expect(octokit.__calls.createComment).toHaveLength(0);
    // The updated body carries the new review content.
    expect(octokit.__calls.updateComment[0].body).toContain('fresh review');
  });

  it('a second run on the same PR still updates (no duplicate created)', async () => {
    const core = makeFakeCore();
    // First run: no existing comment → create.
    const octokitFirst = makeFakeOctokit({
      files: [file('src/a.js')],
      existingComments: [],
    });
    await run(makePRContext(), {
      config: makeConfig(),
      core,
      octokit: octokitFirst,
      callApi: makeFakeCallApi('first'),
      apiClient: { call: () => Promise.resolve({ success: true, data: '' }) },
    });
    expect(octokitFirst.__calls.createComment).toHaveLength(1);
    expect(octokitFirst.__calls.updateComment).toHaveLength(0);

    // Second run: an existing marker comment is now present → update.
    const octokitSecond = makeFakeOctokit({
      files: [file('src/a.js')],
      existingComments: [
        { id: 1, body: octokitFirst.__calls.createComment[0].body },
      ],
    });
    await run(makePRContext(), {
      config: makeConfig(),
      core,
      octokit: octokitSecond,
      callApi: makeFakeCallApi('second'),
      apiClient: { call: () => Promise.resolve({ success: true, data: '' }) },
    });
    expect(octokitSecond.__calls.updateComment).toHaveLength(1);
    expect(octokitSecond.__calls.createComment).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * No patchable files (short-circuit, end-to-end)
 * ------------------------------------------------------------------ */

describe('integration: pull_request auto-review — no patchable files', () => {
  it('short-circuits: NO callApi and NO comment upsert (all binary/no-patch)', async () => {
    const core = makeFakeCore();
    const octokit = makeFakeOctokit({
      files: [
        { filename: 'logo.png', status: 'added' /* no patch */ },
        { filename: 'binary.bin', status: 'modified' /* no patch */ },
      ],
    });
    const callApi = makeFakeCallApi('should not run');

    await run(makePRContext(), {
      config: makeConfig(),
      core,
      octokit,
      callApi,
      apiClient: { call: () => Promise.resolve({ success: true, data: '' }) },
    });

    expect(callApi).not.toHaveBeenCalled();
    expect(octokit.__calls.createComment).toHaveLength(0);
    expect(octokit.__calls.updateComment).toHaveLength(0);
    // The short-circuit log fired.
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('No patchable changes'),
    );
  });

  it('short-circuits when every file is excluded', async () => {
    const core = makeFakeCore();
    const octokit = makeFakeOctokit({
      files: [
        file('package-lock.json', '@@ lock @@'),
        file('foo.lock', '@@ lock @@'),
      ],
    });
    const callApi = makeFakeCallApi('should not run');
    const config = makeConfig({
      excludePatterns: ['*.lock', 'package-lock.json'],
    });

    await run(makePRContext(), {
      config,
      core,
      octokit,
      callApi,
      apiClient: { call: () => Promise.resolve({ success: true, data: '' }) },
    });

    // Everything was excluded → no patchable files → no callApi, no comment.
    expect(callApi).not.toHaveBeenCalled();
    expect(octokit.__calls.createComment).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Excludes applied
 * ------------------------------------------------------------------ */

describe('integration: pull_request auto-review — excludes applied', () => {
  it('an excluded file is NOT present in the review prompt', async () => {
    const core = makeFakeCore();
    const octokit = makeFakeOctokit({
      files: [
        file('src/a.js', '@@ -1 +1 @@\n+kept'),
        file('package-lock.json', '@@ -1 +1 @@\n+lock'), // excluded
        file('secrets.lock', '@@ -1 +1 @@\n+lock'), // excluded (*.lock)
      ],
    });
    const callApi = makeFakeCallApi('review');
    const config = makeConfig({
      excludePatterns: ['*.lock', 'package-lock.json'],
    });

    await run(makePRContext(), {
      config,
      core,
      octokit,
      callApi,
      apiClient: { call: () => Promise.resolve({ success: true, data: '' }) },
    });

    expect(callApi).toHaveBeenCalledTimes(1);
    const prompt = callApi.mock.calls[0][2];
    expect(prompt).toContain('src/a.js');
    expect(prompt).toContain('kept');
    expect(prompt).not.toContain('package-lock.json');
    expect(prompt).not.toContain('secrets.lock');
  });
});

/* ------------------------------------------------------------------ *
 * callApi failure
 * ------------------------------------------------------------------ */

describe('integration: pull_request auto-review — callApi failure', () => {
  it('a rejecting callApi propagates out of run (small-PR path)', async () => {
    // On the SMALL-PR path the router calls callApi directly and has no
    // try/catch around it, so a rejection must propagate out of run() —
    // main()'s .catch → core.setFailed handles it in production.
    const core = makeFakeCore();
    const octokit = makeFakeOctokit({ files: [file('src/a.js')] });
    const callApi = makeFakeCallApi('unused', {
      rejectWith: 'upstream Z.ai timeout',
    });

    await expect(
      run(makePRContext(), {
        config: makeConfig(),
        core,
        octokit,
        callApi,
        apiClient: { call: () => Promise.resolve({ success: true, data: '' }) },
      }),
    ).rejects.toThrow('upstream Z.ai timeout');

    // No comment posted (the failure happened before the upsert).
    expect(octokit.__calls.createComment).toHaveLength(0);
    expect(octokit.__calls.updateComment).toHaveLength(0);
  });

  it('large-PR synthesis failure still posts a fallback comment (runAutoReview swallows synthesis errors)', async () => {
    // runAutoReview catches synthesis failures and returns buildFallbackReview,
    // so the large-PR path posts a comment even when the FINAL callApi fails —
    // as long as per-batch calls succeeded. This is the documented behavior
    // (see src/lib/auto-review.js runAutoReview catch block).
    const core = makeFakeCore();
    const config = makeConfig({ largePrFileThreshold: 1 });
    const files = [
      file('src/a.js', '@@ -1 +1 @@\n+a'),
      file('src/b.js', '@@ -1 +1 @@\n+b'),
    ];
    const octokit = makeFakeOctokit({ files });
    // Per-batch calls succeed; the synthesis call (the one whose prompt contains
    // 'senior synthesizer') rejects.
    const callApi = makeFakeCallApi((_api, _model, prompt) => {
      if (prompt.includes('senior synthesizer')) {
        throw new Error('synthesis blew up');
      }
      return 'per-batch review';
    });

    await run(makePRContext(), {
      config,
      core,
      octokit,
      callApi,
      apiClient: { call: () => Promise.resolve({ success: true, data: '' }) },
    });

    // A comment was still posted (with the fallback content).
    expect(octokit.__calls.createComment).toHaveLength(1);
    const body = octokit.__calls.createComment[0].body;
    expect(body).toContain(MARKER);
    // The fallback note is present.
    expect(body.toLowerCase()).toContain('synthesis was unavailable');
    // runAutoReview warned about the synthesis failure.
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Auto-review synthesis failed'),
    );
  });
});
