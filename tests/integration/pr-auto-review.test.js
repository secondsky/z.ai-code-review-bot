/**
 * Integration tests: pull_request → structured review → inline review pipeline.
 *
 * These tests drive `run(context, deps)` from `src/index.js` end-to-end through
 * the REAL module wiring: the real `getChangedFiles`, `filterExcludedFiles`,
 * `filterPatchableFiles`, `runStructuredReview`, `isLargePr`,
 * `formatFindingsAsSummary`, `buildCommentBody`, `upsertReviewComment`,
 * `partitionFindings`, `buildReviewBody`, `buildReviewComments`, `upsertReview`,
 * `postFallbackComment`, and `parseCommand` helpers — only the outermost
 * collaborators (octokit, core, callApi) are faked. This is the full-stack
 * proof that the modules COMPOSE correctly through the router.
 *
 * Phase 2 routing: when findings map to diff lines, the router posts a GitHub
 * REVIEW with inline comments (pulls.createReview, dismiss-stale-then-post).
 * When no finding maps (all file-level or unmappable), it falls back to the
 * legacy single summary issue comment (upsertReviewComment).
 *
 * Matrix:
 *   - small PR no findings → summary comment (createComment)
 *   - findings on added lines → inline review (createReview with comments)
 *   - file-level findings only → summary comment (no inline)
 *   - review API failure → fallback comment (createComment)
 *   - idempotent update (marker) → updateComment (summary path)
 *   - no patchable files → short-circuit
 *   - excludes applied
 *   - callApi failure → propagates
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

/**
 * A valid structured-review payload the fake model returns. The findings
 * reference files in the PR so the anti-hallucination filter keeps them.
 */
const structuredPayload = (summary, findings) =>
  JSON.stringify({ summary, findings });

const finding = (f, overrides = {}) => ({
  file: f,
  line: 1,
  severity: 'high',
  confidence: 'medium',
  category: 'bug',
  title: `Issue in ${f}`,
  description: 'A concrete bug.',
  evidence: '+bad = null;',
  suggestion: 'Add a null check.',
  rule: 'llm',
  ...overrides,
});

/* ------------------------------------------------------------------ *
 * Small PR — no findings → summary comment path
 * ------------------------------------------------------------------ */

describe('integration: pull_request structured review — small PR', () => {
  it('calls callApi once (1 batch) with a prompt containing both files and posts ONE summary comment', async () => {
    const core = makeFakeCore();
    const octokit = makeFakeOctokit({
      files: [
        file('src/a.js', '@@ -1 +1 @@\n+const a = 1;'),
        file('src/b.js', '@@ -2 +2 @@\n+const b = 2;'),
      ],
    });
    const callApi = makeFakeCallApi(
      structuredPayload('Two files look fine.', []),
    );
    const config = makeConfig();

    await run(makePRContext(), {
      config,
      core,
      octokit,
      callApi,
      apiClient: { call: () => Promise.resolve({ success: true, data: '' }) },
    });

    // callApi invoked exactly once (single batch for a small PR).
    expect(callApi).toHaveBeenCalledTimes(1);
    const [apiKey, model, prompt] = callApi.mock.calls[0];
    expect(apiKey).toBe('test-api-key');
    expect(model).toBe('glm-5.2');
    // The structured prompt contains BOTH files' diffs.
    expect(prompt).toContain('src/a.js');
    expect(prompt).toContain('src/b.js');
    expect(prompt).toContain('const a = 1;');
    expect(prompt).toContain('const b = 2;');
    // The prompt instructs structured JSON output.
    expect(prompt).toContain('Output ONLY a valid JSON');

    // No findings → summary comment path (no inline review).
    expect(octokit.__calls.createComment).toHaveLength(1);
    expect(octokit.__calls.createReview).toHaveLength(0);
    expect(octokit.__calls.updateComment).toHaveLength(0);
    const body = octokit.__calls.createComment[0].body;
    // The body carries the reviewer name (title) and the hidden MARKER.
    expect(body).toContain('Z.ai Code Review');
    expect(body).toContain(MARKER);
    // The structured-summary renderer emits the "No issues found" empty state.
    expect(body).toContain('No issues found');
  });

  it('lists files once and posts to the PR number from the context', async () => {
    const core = makeFakeCore();
    const octokit = makeFakeOctokit({ files: [file('src/a.js')] });
    const callApi = makeFakeCallApi(structuredPayload('ok', []));
    const ctx = makePRContext({ number: 77, owner: 'acme', repo: 'widget' });

    await run(ctx, {
      config: makeConfig(),
      core,
      octokit,
      callApi,
      apiClient: { call: () => Promise.resolve({ success: true, data: '' }) },
    });

    expect(octokit.__calls.listFiles).toHaveLength(1);
    expect(octokit.__calls.listFiles[0]).toMatchObject({
      owner: 'acme',
      repo: 'widget',
      pull_number: 77,
    });
    expect(octokit.__calls.createComment[0]).toMatchObject({
      owner: 'acme',
      repo: 'widget',
      issue_number: 77,
    });
  });
});

/* ------------------------------------------------------------------ *
 * Inline review path (Phase 2 headline feature)
 * ------------------------------------------------------------------ */

describe('integration: pull_request structured review — inline review', () => {
  it('posts findings as a GitHub REVIEW with inline comments on added lines', async () => {
    const core = makeFakeCore();
    const octokit = makeFakeOctokit({
      files: [file('src/a.js', '@@ -1 +1 @@\n+const a = null;')],
    });
    const callApi = makeFakeCallApi(
      structuredPayload('One issue found.', [finding('src/a.js')]),
    );

    await run(makePRContext(), {
      config: makeConfig(),
      core,
      octokit,
      callApi,
      apiClient: { call: () => Promise.resolve({ success: true, data: '' }) },
    });

    // A REVIEW was created (not an issue comment).
    expect(octokit.__calls.createReview).toHaveLength(1);
    expect(octokit.__calls.createComment).toHaveLength(0);
    const review = octokit.__calls.createReview[0];
    expect(review).toMatchObject({
      owner: 'owner',
      repo: 'repo',
      pull_number: 42,
      event: 'COMMENT',
    });
    // The review body carries the summary + marker.
    expect(review.body).toContain('One issue found.');
    expect(review.body).toContain(MARKER);
    // Exactly one inline comment, anchored to line 1 (the added line), RIGHT side.
    expect(review.comments).toHaveLength(1);
    expect(review.comments[0]).toMatchObject({
      path: 'src/a.js',
      line: 1,
      side: 'RIGHT',
    });
    // The inline comment body has the high-severity emoji + finding content.
    expect(review.comments[0].body).toContain('🟠');
    expect(review.comments[0].body).toContain('Issue in src/a.js');
    expect(review.comments[0].body).toContain('A concrete bug.');
  });

  it('dismisses prior bot reviews before posting (idempotent per SHA)', async () => {
    const core = makeFakeCore();
    const oldReview = {
      id: 777,
      body: `stale\n\n${MARKER}`,
      user: { login: 'zai-code-review[bot]' },
    };
    const octokit = makeFakeOctokit({
      files: [file('src/a.js', '@@ -1 +1 @@\n+const a = null;')],
      existingReviews: [oldReview],
    });
    const callApi = makeFakeCallApi(
      structuredPayload('fresh.', [finding('src/a.js')]),
    );

    await run(makePRContext({ sha: 'feedface' }), {
      config: makeConfig(),
      core,
      octokit,
      callApi,
      apiClient: { call: () => Promise.resolve({ success: true, data: '' }) },
    });

    // The stale review was dismissed with a reason referencing the new SHA.
    expect(octokit.__calls.dismissReview).toHaveLength(1);
    expect(octokit.__calls.dismissReview[0]).toMatchObject({
      review_id: 777,
      pull_number: 42,
    });
    expect(octokit.__calls.dismissReview[0].message).toContain('feedface');
    // Then the new review was created.
    expect(octokit.__calls.createReview).toHaveLength(1);
  });

  it('falls back to a summary comment when the review API fails', async () => {
    const core = makeFakeCore();
    const octokit = makeFakeOctokit({
      files: [file('src/a.js', '@@ -1 +1 @@\n+const a = null;')],
      createReviewFails: true,
    });
    const callApi = makeFakeCallApi(
      structuredPayload('issue.', [finding('src/a.js')]),
    );

    await run(makePRContext(), {
      config: makeConfig(),
      core,
      octokit,
      callApi,
      apiClient: { call: () => Promise.resolve({ success: true, data: '' }) },
    });

    // Review was attempted but failed → fallback issue comment posted.
    expect(octokit.__calls.createReview).toHaveLength(1);
    expect(octokit.__calls.createComment).toHaveLength(1);
    const body = octokit.__calls.createComment[0].body;
    // The fallback body carries the review summary + the findings list.
    expect(body).toContain('issue.');
    expect(body).toContain('src/a.js');
    expect(body).toContain('Issue in src/a.js');
    expect(core.warning).toHaveBeenCalled();
  });

  it('posts a summary comment (no review) when all findings are file-level', async () => {
    const core = makeFakeCore();
    const octokit = makeFakeOctokit({
      files: [file('src/a.js', '@@ -1 +1 @@\n+const a = 1;')],
    });
    // A file-level finding (line: null) cannot map to a diff line.
    const callApi = makeFakeCallApi(
      structuredPayload('file issue.', [finding('src/a.js', { line: null })]),
    );

    await run(makePRContext(), {
      config: makeConfig(),
      core,
      octokit,
      callApi,
      apiClient: { call: () => Promise.resolve({ success: true, data: '' }) },
    });

    // No inline findings → summary comment path (no review created).
    expect(octokit.__calls.createReview).toHaveLength(0);
    expect(octokit.__calls.createComment).toHaveLength(1);
    const body = octokit.__calls.createComment[0].body;
    // The summary renderer lists the finding with its file + title.
    expect(body).toContain('src/a.js');
    expect(body).toContain('Issue in src/a.js');
    expect(body).toContain(MARKER);
  });
});

/* ------------------------------------------------------------------ *
 * Large PR (batched)
 * ------------------------------------------------------------------ */

describe('integration: pull_request structured review — large PR', () => {
  it('batches: callApi called more than once and a structured comment is posted', async () => {
    const core = makeFakeCore();
    // Force multiple batches via a tiny maxBatchChars.
    const config = makeConfig({ maxBatchChars: 1500 });
    const files = [
      file('src/a.js', '@@ -1 +1 @@\n+' + 'a'.repeat(800)),
      file('src/b.js', '@@ -1 +1 @@\n+' + 'b'.repeat(800)),
      file('src/c.js', '@@ -1 +1 @@\n+' + 'c'.repeat(800)),
    ];
    const octokit = makeFakeOctokit({ files });
    const callApi = makeFakeCallApi(
      structuredPayload('Batch reviewed.', []),
    );

    await run(makePRContext(), {
      config,
      core,
      octokit,
      callApi,
      apiClient: { call: () => Promise.resolve({ success: true, data: '' }) },
    });

    // Multiple batches → callApi called more than once.
    expect(callApi.mock.calls.length).toBeGreaterThan(1);

    // No findings → summary comment path.
    expect(octokit.__calls.createComment).toHaveLength(1);
    const body = octokit.__calls.createComment[0].body;
    expect(body).toContain(MARKER);
    expect(body).toContain('Z.ai Code Review');
  });
});

/* ------------------------------------------------------------------ *
 * Idempotent update (summary path)
 * ------------------------------------------------------------------ */

describe('integration: pull_request structured review — idempotent update', () => {
  it('updates the existing MARKER comment instead of creating a duplicate', async () => {
    const core = makeFakeCore();
    const oldBody = `## Z.ai Code Review\n\nold review\n\n${MARKER}`;
    const octokit = makeFakeOctokit({
      files: [file('src/a.js')],
      existingComments: [{ id: 555, body: oldBody }],
    });
    const callApi = makeFakeCallApi(structuredPayload('fresh', []));

    await run(makePRContext(), {
      config: makeConfig(),
      core,
      octokit,
      callApi,
      apiClient: { call: () => Promise.resolve({ success: true, data: '' }) },
    });

    // No findings → summary path → updateComment used (NOT createComment).
    expect(octokit.__calls.updateComment).toHaveLength(1);
    expect(octokit.__calls.updateComment[0].comment_id).toBe(555);
    expect(octokit.__calls.createComment).toHaveLength(0);
    // The updated body carries the marker (re-rendered summary).
    expect(octokit.__calls.updateComment[0].body).toContain(MARKER);
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
      callApi: makeFakeCallApi(structuredPayload('first', [])),
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
      callApi: makeFakeCallApi(structuredPayload('second', [])),
      apiClient: { call: () => Promise.resolve({ success: true, data: '' }) },
    });
    expect(octokitSecond.__calls.updateComment).toHaveLength(1);
    expect(octokitSecond.__calls.createComment).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * No patchable files (short-circuit, end-to-end)
 * ------------------------------------------------------------------ */

describe('integration: pull_request structured review — no patchable files', () => {
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
    expect(octokit.__calls.createReview).toHaveLength(0);
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

    expect(callApi).not.toHaveBeenCalled();
    expect(octokit.__calls.createComment).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Excludes applied
 * ------------------------------------------------------------------ */

describe('integration: pull_request structured review — excludes applied', () => {
  it('an excluded file is NOT present in the review prompt', async () => {
    const core = makeFakeCore();
    const octokit = makeFakeOctokit({
      files: [
        file('src/a.js', '@@ -1 +1 @@\n+kept'),
        file('package-lock.json', '@@ -1 +1 @@\n+lock'), // excluded
        file('secrets.lock', '@@ -1 +1 @@\n+lock'), // excluded (*.lock)
      ],
    });
    const callApi = makeFakeCallApi(structuredPayload('ok', []));
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

describe('integration: pull_request structured review — callApi failure', () => {
  it('a rejecting callApi propagates out of run (no synthesis fallback in v2)', async () => {
    // The v2 pipeline has no synthesis/fallback step. A callApi rejection
    // propagates out of runStructuredReview → run → main's .catch → setFailed.
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
    expect(octokit.__calls.createReview).toHaveLength(0);
  });
});
