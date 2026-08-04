/**
 * Tests for src/lib/schedule.js — scheduled batch re-review of open PRs.
 *
 * All collaborators are injected (DI-first): no network, no real GitHub. The
 * fakes record calls so we assert on the meaningful outcomes (which PRs were
 * reviewed, which skipped, the dedup-by-SHA logic, per-PR failure isolation).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runScheduledReview,
  listOpenPrs,
  hasReviewForSha,
  reviewOnePr,
  DEFAULT_MAX_PRS,
} from '../src/lib/schedule.js';
import { MARKER } from '../src/lib/comments.js';

/* ---------- fakes ---------- */

const mkPr = (number, headSha, { draft = false, title = 'PR' } = {}) => ({
  number,
  headSha,
  draft,
  title,
});

function makeOctokit({ prs = [], commentsByPr = {} } = {}) {
  const calls = {
    pullsList: [],
    listComments: [],
    listFiles: [],
    createComment: [],
    updateComment: [],
  };
  const octokit = {
    rest: {
      pulls: {
        async list(params) {
          calls.pullsList.push(params);
          return { data: prs };
        },
      },
      issues: {
        async listComments(params) {
          calls.listComments.push(params);
          const list = commentsByPr[params.issue_number] ?? [];
          return { data: list };
        },
        async createComment(params) {
          calls.createComment.push(params);
          return { data: { id: 1 } };
        },
        async updateComment(params) {
          calls.updateComment.push(params);
          return { data: { id: params.comment_id } };
        },
      },
    },
  };
  octokit.__calls = calls;
  return octokit;
}

// Minimal stubs for the pipeline helpers — they don't need to be real for
// schedule-unit tests; we assert on whether reviewOnePr was reached.
const stubs = {
  getChangedFiles: vi.fn(async () => [{ filename: 'a.js', status: 'modified', patch: '@@' }]),
  filterExcludedFiles: vi.fn((files) => files),
  filterPatchableFiles: vi.fn((files) => files),
  buildAutoReviewPrompt: vi.fn(() => 'prompt'),
  runAutoReview: vi.fn(async () => 'batch review'),
  isLargePr: vi.fn(() => false),
  buildCommentBody: vi.fn(({ content }) => `${content}\n\n${MARKER}`),
  upsertReviewComment: vi.fn(async () => ({ action: 'created', commentId: 1 })),
};

function makeConfig(overrides = {}) {
  return {
    apiKey: 'k',
    model: 'm',
    reviewerName: 'Z.ai Code Review',
    excludePatterns: [],
    maxDiffChars: 100000,
    largePrFileThreshold: 50,
    ...overrides,
  };
}

/* ---------- listOpenPrs ---------- */

describe('listOpenPrs', () => {
  it('returns a minimal shape per PR and respects the maxPrs cap', async () => {
    const prs = [
      { number: 1, head: { sha: 'aaa' }, draft: false, title: 'A' },
      { number: 2, head: { sha: 'bbb' }, draft: true, title: 'B' },
      { number: 3, head: { sha: 'ccc' }, draft: false, title: 'C' },
    ];
    const octokit = makeOctokit({ prs });
    const out = await listOpenPrs({ octokit, owner: 'o', repo: 'r', maxPrs: 2 });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ number: 1, headSha: 'aaa', draft: false, title: 'A' });
    expect(out[1]).toEqual({ number: 2, headSha: 'bbb', draft: true, title: 'B' });
  });

  it('paginates until a short page', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => ({ number: i + 1, head: { sha: 's' }, draft: false, title: 'p' }));
    const page2 = [{ number: 51, head: { sha: 't' }, draft: false, title: 'last' }];
    let call = 0;
    const octokit = {
      rest: {
        pulls: {
          async list() {
            call += 1;
            return { data: call === 1 ? page1 : page2 };
          },
        },
      },
    };
    const out = await listOpenPrs({ octokit, owner: 'o', repo: 'r', maxPrs: 100, perPage: 50 });
    expect(out.length).toBe(51);
  });
});

/* ---------- hasReviewForSha ---------- */

describe('hasReviewForSha', () => {
  it('returns true when a comment contains the marker AND the head SHA', async () => {
    const octokit = makeOctokit({
      commentsByPr: { 42: [{ body: `## Z.ai Code Review\n...sha-abc...\n\n${MARKER}` }] },
    });
    const found = await hasReviewForSha({ octokit, owner: 'o', repo: 'r', pullNumber: 42, headSha: 'sha-abc' });
    expect(found).toBe(true);
  });

  it('returns false when a marker exists but for a DIFFERENT SHA (re-push)', async () => {
    const octokit = makeOctokit({
      commentsByPr: { 42: [{ body: `old review for sha-old\n\n${MARKER}` }] },
    });
    const found = await hasReviewForSha({ octokit, owner: 'o', repo: 'r', pullNumber: 42, headSha: 'sha-new' });
    expect(found).toBe(false);
  });

  it('returns false when no marker comment exists', async () => {
    const octokit = makeOctokit({ commentsByPr: { 42: [{ body: 'unrelated' }] } });
    const found = await hasReviewForSha({ octokit, owner: 'o', repo: 'r', pullNumber: 42, headSha: 'sha' });
    expect(found).toBe(false);
  });
});

/* ---------- runScheduledReview ---------- */

describe('runScheduledReview', () => {
  it('reviews PRs that have no existing review for their SHA', async () => {
    const octokit = makeOctokit({
      prs: [mkPr(1, 'sha1'), mkPr(2, 'sha2')],
      commentsByPr: {}, // no existing reviews
    });
    const callApi = vi.fn(async () => 'review');
    const core = { info: vi.fn(), warning: vi.fn() };

    const result = await runScheduledReview({
      octokit, owner: 'o', repo: 'r', config: makeConfig(), core, callApi, ...stubs,
    });

    expect(result).toEqual({ reviewed: 2, skipped: 0, failed: 0 });
    expect(callApi).toHaveBeenCalledTimes(2);
    expect(stubs.upsertReviewComment).toHaveBeenCalledTimes(2);
  });

  it('skips drafts', async () => {
    const octokit = makeOctokit({
      prs: [mkPr(1, 'sha1', { draft: true }), mkPr(2, 'sha2')],
      commentsByPr: {},
    });
    const callApi = vi.fn(async () => 'review');
    const result = await runScheduledReview({
      octokit, owner: 'o', repo: 'r', config: makeConfig(), core: { info() {}, warning() {} }, callApi, ...stubs,
    });
    expect(result.reviewed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(callApi).toHaveBeenCalledTimes(1);
  });

  it('skips PRs already reviewed at the current head SHA (dedup)', async () => {
    const octokit = makeOctokit({
      prs: [mkPr(1, 'sha1'), mkPr(2, 'sha2')],
      commentsByPr: {
        1: [{ body: `review for sha1\n\n${MARKER}` }], // already reviewed
      },
    });
    const callApi = vi.fn(async () => 'review');
    const result = await runScheduledReview({
      octokit, owner: 'o', repo: 'r', config: makeConfig(), core: { info() {}, warning() {} }, callApi, ...stubs,
    });
    expect(result.reviewed).toBe(1); // only PR #2
    expect(result.skipped).toBe(1);
    expect(callApi).toHaveBeenCalledTimes(1);
  });

  it('isolates per-PR failures: one bad PR does not stop the batch', async () => {
    const octokit = makeOctokit({
      prs: [mkPr(1, 'sha1'), mkPr(2, 'sha2'), mkPr(3, 'sha3')],
      commentsByPr: {},
    });
    // callApi throws for PR #2 (identified by the prompt content from stubs).
    let n = 0;
    const callApi = vi.fn(async () => {
      n += 1;
      if (n === 2) throw new Error('boom');
      return 'review';
    });
    const core = { info: vi.fn(), warning: vi.fn() };
    const result = await runScheduledReview({
      octokit, owner: 'o', repo: 'r', config: makeConfig(), core, callApi, ...stubs,
    });
    expect(result.reviewed).toBe(2);
    expect(result.failed).toBe(1);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('PR #2 failed'));
  });

  it('uses the large-PR path when isLargePr returns true', async () => {
    const octokit = makeOctokit({ prs: [mkPr(1, 'sha1')], commentsByPr: {} });
    const callApi = vi.fn(async () => 'review');
    const bigStubs = { ...stubs, isLargePr: vi.fn(() => true) };
    await runScheduledReview({
      octokit, owner: 'o', repo: 'r', config: makeConfig(), core: { info() {}, warning() {} }, callApi, ...bigStubs,
    });
    expect(bigStubs.runAutoReview).toHaveBeenCalledTimes(1);
    expect(callApi).not.toHaveBeenCalled(); // batched path uses runAutoReview, not callApi directly
  });

  it('respects scheduleMaxPrs from config', async () => {
    const octokit = makeOctokit({
      prs: [mkPr(1, 's1'), mkPr(2, 's2'), mkPr(3, 's3')],
      commentsByPr: {},
    });
    const callApi = vi.fn(async () => 'r');
    const result = await runScheduledReview({
      octokit, owner: 'o', repo: 'r',
      config: makeConfig({ scheduleMaxPrs: 2 }),
      core: { info() {}, warning() {} }, callApi, ...stubs,
    });
    expect(result.reviewed).toBe(2);
  });
});
