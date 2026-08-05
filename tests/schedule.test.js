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
import { partitionFindings } from '../src/lib/diff.js';
import {
  buildReviewBody,
  buildReviewComments,
  resolveReviewEvent,
} from '../src/lib/review.js';

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

// Build fresh stubs per test so spy call counts don't leak across tests.
const makeStubs = (overrides = {}) => ({
  getChangedFiles: vi.fn(async () => [{ filename: 'a.js', status: 'modified', patch: '@@' }]),
  filterExcludedFiles: vi.fn((files) => files),
  filterPatchableFiles: vi.fn((files) => files),
  runStructuredReview: vi.fn(async () => ({
    findings: [],
    summary: 'batch review',
    metadata: { totalBatches: 1, totalFindingsBeforeCap: 0, deterministicFindingsCount: 0, batchMetadata: [] },
  })),
  isLargePr: vi.fn(() => false),
  formatFindingsAsSummary: vi.fn(() => `## Z.ai Code Review\n\nreview\n\n${MARKER}`),
  buildCommentBody: vi.fn(({ content }) => `${content}\n\n${MARKER}`),
  upsertReviewComment: vi.fn(async () => ({ action: 'created', commentId: 1 })),
  // v2 inline-review pipeline deps. The pure builders + partitionFindings are
  // real (so the inline/summaryOnly split is exercised truthfully); the I/O
  // collaborators (upsertReview, postFallbackComment) are fakes so we can spy.
  partitionFindings,
  buildReviewBody,
  buildReviewComments,
  resolveReviewEvent,
  upsertReview: vi.fn(async () => ({ id: 1, commentCount: 0, dismissedCount: 0 })),
  postFallbackComment: vi.fn(async () => ({ id: 9 })),
  ...overrides,
});

describe('runScheduledReview', () => {
  it('reviews PRs that have no existing review for their SHA', async () => {
    const octokit = makeOctokit({
      prs: [mkPr(1, 'sha1'), mkPr(2, 'sha2')],
      commentsByPr: {}, // no existing reviews
    });
    const callApi = vi.fn(async () => 'review');
    const core = { info: vi.fn(), warning: vi.fn() };
    const s = makeStubs();

    const result = await runScheduledReview({
      octokit, owner: 'o', repo: 'r', config: makeConfig(), core, callApi, ...s,
    });

    expect(result).toEqual({ reviewed: 2, skipped: 0, failed: 0 });
    expect(s.runStructuredReview).toHaveBeenCalledTimes(2);
    expect(s.upsertReviewComment).toHaveBeenCalledTimes(2);
  });

  it('skips drafts', async () => {
    const octokit = makeOctokit({
      prs: [mkPr(1, 'sha1', { draft: true }), mkPr(2, 'sha2')],
      commentsByPr: {},
    });
    const callApi = vi.fn(async () => 'review');
    const s = makeStubs();
    const result = await runScheduledReview({
      octokit, owner: 'o', repo: 'r', config: makeConfig(), core: { info() {}, warning() {} }, callApi, ...s,
    });
    expect(result.reviewed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(s.runStructuredReview).toHaveBeenCalledTimes(1);
  });

  it('skips PRs already reviewed at the current head SHA (dedup)', async () => {
    const octokit = makeOctokit({
      prs: [mkPr(1, 'sha1'), mkPr(2, 'sha2')],
      commentsByPr: {
        1: [{ body: `review for sha1\n\n${MARKER}` }], // already reviewed
      },
    });
    const callApi = vi.fn(async () => 'review');
    const s = makeStubs();
    const result = await runScheduledReview({
      octokit, owner: 'o', repo: 'r', config: makeConfig(), core: { info() {}, warning() {} }, callApi, ...s,
    });
    expect(result.reviewed).toBe(1); // only PR #2
    expect(result.skipped).toBe(1);
    expect(s.runStructuredReview).toHaveBeenCalledTimes(1);
  });

  it('isolates per-PR failures: one bad PR does not stop the batch', async () => {
    const octokit = makeOctokit({
      prs: [mkPr(1, 'sha1'), mkPr(2, 'sha2'), mkPr(3, 'sha3')],
      commentsByPr: {},
    });
    // runStructuredReview throws for PR #2 (the 2nd reviewed PR).
    let n = 0;
    const s = makeStubs({
      runStructuredReview: vi.fn(async () => {
        n += 1;
        if (n === 2) throw new Error('boom');
        return {
          findings: [],
          summary: 'ok',
          metadata: { totalBatches: 1, totalFindingsBeforeCap: 0, deterministicFindingsCount: 0, batchMetadata: [] },
        };
      }),
    });
    const core = { info: vi.fn(), warning: vi.fn() };
    const result = await runScheduledReview({
      octokit, owner: 'o', repo: 'r', config: makeConfig(), core, callApi: vi.fn(), ...s,
    });
    expect(result.reviewed).toBe(2);
    expect(result.failed).toBe(1);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('PR #2 failed'));
  });

  it('uses the structured-review path when isLargePr returns true', async () => {
    const octokit = makeOctokit({ prs: [mkPr(1, 'sha1')], commentsByPr: {} });
    const callApi = vi.fn(async () => 'review');
    const bigStubs = makeStubs({ isLargePr: vi.fn(() => true) });
    await runScheduledReview({
      octokit, owner: 'o', repo: 'r', config: makeConfig(), core: { info() {}, warning() {} }, callApi, ...bigStubs,
    });
    // The structured-review pipeline is the single path now (batching handles
    // both small and large PRs); isLargePr is still passed through for future use.
    expect(bigStubs.runStructuredReview).toHaveBeenCalledTimes(1);
    expect(bigStubs.formatFindingsAsSummary).toHaveBeenCalledTimes(1);
  });

  it('respects scheduleMaxPrs from config', async () => {
    const octokit = makeOctokit({
      prs: [mkPr(1, 's1'), mkPr(2, 's2'), mkPr(3, 's3')],
      commentsByPr: {},
    });
    const callApi = vi.fn(async () => 'r');
    const s = makeStubs();
    const result = await runScheduledReview({
      octokit, owner: 'o', repo: 'r',
      config: makeConfig({ scheduleMaxPrs: 2 }),
      core: { info() {}, warning() {} }, callApi, ...s,
    });
    expect(result.reviewed).toBe(2);
  });
});

/* ---------- reviewOnePr (v2 inline pipeline) ---------- */

// A file with a real patch so partitionFindings can map an inline finding to a
// valid RIGHT-side line. The finding below points at line 2 (an added line).
// (parseFullHunkHeader rejects oldStart < 1, so the hunk must start at line 1.)
const INLINE_PATCH = '@@ -1,0 +2,2 @@\n+const x = 1;\n+const y = 2;\n';
const INLINE_FILE = { filename: 'a.js', status: 'modified', patch: INLINE_PATCH };
const INLINE_FINDING = {
  file: 'a.js',
  line: 2,
  severity: 'high',
  title: 'Bad',
  description: 'd',
};

describe('reviewOnePr', () => {
  it('submits an inline review via upsertReview when findings map to diff lines', async () => {
    const octokit = makeOctokit();
    const callApi = vi.fn(async () => 'review');
    const core = { info: vi.fn(), warning: vi.fn() };
    const s = makeStubs({
      getChangedFiles: vi.fn(async () => [INLINE_FILE]),
      runStructuredReview: vi.fn(async () => ({
        findings: [INLINE_FINDING],
        summary: 'inline review',
        metadata: { totalBatches: 1, totalFindingsBeforeCap: 1, deterministicFindingsCount: 0, batchMetadata: [] },
      })),
    });

    const result = await reviewOnePr({
      pr: mkPr(7, 'sha7'),
      octokit, owner: 'o', repo: 'r',
      config: makeConfig(), core, callApi, ...s,
    });

    expect(result).toEqual({ ok: true, action: 'reviewed' });
    // Inline path: upsertReview called, upsertReviewComment NOT called.
    expect(s.upsertReview).toHaveBeenCalledTimes(1);
    expect(s.upsertReviewComment).not.toHaveBeenCalled();
    // The synthetic context carries owner/repo + pull_request.number + head sha.
    const call = s.upsertReview.mock.calls[0][0];
    expect(call.context.repo).toEqual({ owner: 'o', repo: 'r' });
    expect(call.context.payload.pull_request.number).toBe(7);
    expect(call.context.payload.pull_request.head.sha).toBe('sha7');
    expect(call.sha).toBe('sha7');
    expect(Array.isArray(call.comments)).toBe(true);
    expect(call.comments.length).toBe(1);
  });

  it('falls back to upsertReviewComment when no findings map to diff lines (all file-level)', async () => {
    const octokit = makeOctokit();
    const callApi = vi.fn(async () => 'review');
    const core = { info: vi.fn(), warning: vi.fn() };
    // File-level finding (line: null) → partitionFindings routes to summaryOnly.
    const fileLevelFinding = { file: 'a.js', line: null, severity: 'low', title: 'X', description: 'd' };
    const s = makeStubs({
      getChangedFiles: vi.fn(async () => [INLINE_FILE]),
      runStructuredReview: vi.fn(async () => ({
        findings: [fileLevelFinding],
        summary: 'summary only',
        metadata: { totalBatches: 1, totalFindingsBeforeCap: 1, deterministicFindingsCount: 0, batchMetadata: [] },
      })),
    });

    const result = await reviewOnePr({
      pr: mkPr(8, 'sha8'),
      octokit, owner: 'o', repo: 'r',
      config: makeConfig(), core, callApi, ...s,
    });

    expect(result).toEqual({ ok: true, action: 'reviewed' });
    // Summary path: upsertReviewComment called, upsertReview NOT called.
    expect(s.upsertReviewComment).toHaveBeenCalledTimes(1);
    expect(s.upsertReview).not.toHaveBeenCalled();
  });

  it('posts a fallback comment when upsertReview throws', async () => {
    const octokit = makeOctokit();
    const callApi = vi.fn(async () => 'review');
    const core = { info: vi.fn(), warning: vi.fn() };
    const s = makeStubs({
      getChangedFiles: vi.fn(async () => [INLINE_FILE]),
      runStructuredReview: vi.fn(async () => ({
        findings: [INLINE_FINDING],
        summary: 'inline review',
        metadata: { totalBatches: 1, totalFindingsBeforeCap: 1, deterministicFindingsCount: 0, batchMetadata: [] },
      })),
      upsertReview: vi.fn(async () => {
        throw new Error('review API down');
      }),
    });

    const result = await reviewOnePr({
      pr: mkPr(9, 'sha9'),
      octokit, owner: 'o', repo: 'r',
      config: makeConfig(), core, callApi, ...s,
    });

    // Fallback path: postFallbackComment called; the PR is still "reviewed".
    expect(result).toEqual({ ok: true, action: 'reviewed' });
    expect(s.upsertReview).toHaveBeenCalledTimes(1);
    expect(s.postFallbackComment).toHaveBeenCalledTimes(1);
    expect(s.upsertReviewComment).not.toHaveBeenCalled();
    // The fallback body carries the review body + the inline comment bodies.
    const fbCall = s.postFallbackComment.mock.calls[0][0];
    expect(typeof fbCall.body).toBe('string');
    expect(fbCall.body.length).toBeGreaterThan(0);
  });

  it('threads the new inline deps through runScheduledReview', async () => {
    // End-to-end: runScheduledReview should call upsertReview when a PR has
    // inline findings, proving the new deps are threaded from the batch entry.
    const octokit = makeOctokit({ prs: [mkPr(11, 'sha11')], commentsByPr: {} });
    const callApi = vi.fn(async () => 'review');
    const s = makeStubs({
      getChangedFiles: vi.fn(async () => [INLINE_FILE]),
      runStructuredReview: vi.fn(async () => ({
        findings: [INLINE_FINDING],
        summary: 'inline',
        metadata: { totalBatches: 1, totalFindingsBeforeCap: 1, deterministicFindingsCount: 0, batchMetadata: [] },
      })),
    });

    const result = await runScheduledReview({
      octokit, owner: 'o', repo: 'r', config: makeConfig(),
      core: { info() {}, warning() {} }, callApi, ...s,
    });

    expect(result).toEqual({ reviewed: 1, skipped: 0, failed: 0 });
    expect(s.upsertReview).toHaveBeenCalledTimes(1);
    expect(s.upsertReviewComment).not.toHaveBeenCalled();
  });
});
