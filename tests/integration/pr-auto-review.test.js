/**
 * Integration tests: pull_request → structured review → comment pipeline.
 *
 * These tests drive `run(context, deps)` from `src/index.js` end-to-end through
 * the REAL module wiring: the real `getChangedFiles`, `filterExcludedFiles`,
 * `filterPatchableFiles`, `runStructuredReview`, `isLargePr`,
 * `formatFindingsAsSummary`, `buildCommentBody`, `upsertReviewComment`, and
 * `parseCommand` helpers — only the outermost collaborators (octokit, core,
 * callApi) are faked. This is the full-stack proof that the modules COMPOSE
 * correctly through the router.
 *
 * The v2 pipeline replaces the free-form synthesis approach: runStructuredReview
 * is the single path for both small and large PRs (batching handles small PRs
 * as 1 batch). callApi returns a structured {summary, findings} payload which
 * formatFindingsAsSummary renders into the summary comment.
 *
 * Matrix:
 *   - small PR → callApi once (1 batch), prompt contains both files, one upsert
 *   - large PR → callApi > once (N batches), final structured comment posted
 *   - idempotent update → existing marker comment updated, not duplicated
 *   - no patchable files → NO callApi, NO upsert (short-circuit, end-to-end)
 *   - excludes applied → excluded file NOT in the review prompt
 *   - callApi failure → propagates out of run (no synthesis fallback in v2)
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
 * Small PR
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

    // ONE summary comment was created (no existing marker comment).
    expect(octokit.__calls.createComment).toHaveLength(1);
    expect(octokit.__calls.updateComment).toHaveLength(0);
    const body = octokit.__calls.createComment[0].body;
    // The body carries the reviewer name (title) and the hidden MARKER.
    expect(body).toContain('Z.ai Code Review');
    expect(body).toContain(MARKER);
    // The structured-summary renderer emits the "No issues found" empty state.
    expect(body).toContain('No issues found');
  });

  it('renders findings (with severity emojis) when the model returns issues', async () => {
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

    const body = octokit.__calls.createComment[0].body;
    // The finding is rendered with the high-severity emoji and the file path.
    expect(body).toContain('🟠');
    expect(body).toContain('src/a.js');
    expect(body).toContain('Issue in src/a.js');
    expect(body).toContain(MARKER);
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

    // The final comment was posted and carries the marker.
    expect(octokit.__calls.createComment).toHaveLength(1);
    const body = octokit.__calls.createComment[0].body;
    expect(body).toContain(MARKER);
    expect(body).toContain('Z.ai Code Review');
  });
});

/* ------------------------------------------------------------------ *
 * Idempotent update
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

    // updateComment used (NOT createComment).
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
  });
});
