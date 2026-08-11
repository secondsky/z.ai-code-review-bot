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

function makeOctokit({ prs = [], commentsByPr = {}, reviewsByPr = {} } = {}) {
  const calls = {
    pullsList: [],
    listComments: [],
    listReviews: [],
    listFiles: [],
    createComment: [],
    updateComment: [],
  };
  // Convert the simplified mkPr shape ({number, headSha, draft, title}) into
  // the GitHub API shape listOpenPrs reads ({number, head:{sha}, draft, title})
  // so the round-trip through pulls.list preserves the head SHA.
  const apiPrs = prs.map((p) => ({
    number: p.number,
    head: { sha: p.headSha ?? p?.head?.sha ?? '' },
    draft: p.draft === true,
    title: typeof p.title === 'string' ? p.title : '',
  }));
  const octokit = {
    rest: {
      pulls: {
        async list(params) {
          calls.pullsList.push(params);
          // Simulate real GitHub pagination: slice the full list by the
          // requested page/per_page so the loop sees a short final page and
          // terminates. Without this, the full array is returned on every call
          // and a correctly-paginating loop would re-read the same PRs forever.
          const perPage = typeof params?.per_page === 'number' && params.per_page > 0
            ? params.per_page
            : 50;
          const page = typeof params?.page === 'number' && params.page > 0
            ? params.page
            : 1;
          const start = (page - 1) * perPage;
          const slice = apiPrs.slice(start, start + perPage);
          return { data: slice };
        },
        async listReviews(params) {
          calls.listReviews.push(params);
          const list = reviewsByPr[params.pull_number] ?? [];
          return { data: list };
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
  it('returns a minimal shape per PR and respects the maxPrs cap (drafts skipped)', async () => {
    // CFG-3: drafts are excluded from the output (and so do not count toward
    // the cap). The cap applies to non-draft PRs only.
    const prs = [
      { number: 1, head: { sha: 'aaa' }, draft: false, title: 'A' },
      { number: 2, head: { sha: 'bbb' }, draft: true, title: 'B' },
      { number: 3, head: { sha: 'ccc' }, draft: false, title: 'C' },
    ];
    const octokit = makeOctokit({ prs });
    const out = await listOpenPrs({ octokit, owner: 'o', repo: 'r', maxPrs: 2 });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ number: 1, headSha: 'aaa', draft: false, title: 'A' });
    expect(out[1]).toEqual({ number: 3, headSha: 'ccc', draft: false, title: 'C' });
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

  it('does NOT count drafts toward the maxPrs cap (CFG-3)', async () => {
    // 10 drafts + 5 non-drafts, maxPrs=10. Drafts must be skipped entirely
    // (not pushed, not counted) so the result contains the 5 non-draft PRs
    // rather than being filled with drafts and starving real PRs.
    const drafts = Array.from({ length: 10 }, (_, i) => ({
      number: 100 + i,
      head: { sha: `d${i}` },
      draft: true,
      title: `draft ${i}`,
    }));
    const real = Array.from({ length: 5 }, (_, i) => ({
      number: 200 + i,
      head: { sha: `r${i}` },
      draft: false,
      title: `real ${i}`,
    }));
    const octokit = makeOctokit({ prs: [...drafts, ...real] });
    const out = await listOpenPrs({ octokit, owner: 'o', repo: 'r', maxPrs: 10 });
    expect(out).toHaveLength(5);
    expect(out.every((pr) => pr.draft === false)).toBe(true);
    expect(out.map((pr) => pr.number).sort()).toEqual([200, 201, 202, 203, 204]);
  });

  // ----- W2-1: pagination termination must compare against the ACTUAL page size
  // sent to the API, not the original `perPage` parameter. When maxPrs=10 and
  // page 1 returns 10 drafts (all skipped), the dynamic per_page is
  // min(50, 10-0)=10. After skipping, data.length=10 must be compared against
  // the REQUESTED 10 (not 50) so we keep paginating to find reviewable PRs.
  // The buggy version compared data.length (10) against the original perPage
  // (50), concluded "10 < 50 → last page", and broke after page 1, returning 0
  // PRs even though page 2 had reviewable PRs.
  it('continues paginating when page 1 is all drafts (W2-1 regression)', async () => {
    // Page 1: 10 drafts (all skipped). Page 2: 5 non-draft PRs + a short page
    // to terminate (3 items). maxPrs=10 so the requested per_page for page 1 is
    // min(50, 10) = 10; for page 2 it is min(50, 10-0) = 10 (out.length is still
    // 0 after page 1's drafts were all skipped).
    const page1 = Array.from({ length: 10 }, (_, i) => ({
      number: 100 + i,
      head: { sha: `d${i}` },
      draft: true,
      title: `draft ${i}`,
    }));
    const page2 = Array.from({ length: 5 }, (_, i) => ({
      number: 200 + i,
      head: { sha: `r${i}` },
      draft: false,
      title: `real ${i}`,
    }));
    let call = 0;
    const pullsListCalls = [];
    const octokit = {
      rest: {
        pulls: {
          async list(params) {
            call += 1;
            pullsListCalls.push(params);
            // Page 3 returns an empty array to terminate pagination cleanly.
            if (call === 1) return { data: page1 };
            if (call === 2) return { data: page2 };
            return { data: [] };
          },
        },
      },
    };
    const out = await listOpenPrs({ octokit, owner: 'o', repo: 'r', maxPrs: 10 });
    // Must return the 5 non-draft PRs from page 2 — NOT an empty array.
    expect(out).toHaveLength(5);
    expect(out.every((pr) => pr.draft === false)).toBe(true);
    expect(out.map((pr) => pr.number).sort()).toEqual([200, 201, 202, 203, 204]);
    // And it must have actually requested page 2 (proving it did not terminate
    // after page 1).
    expect(pullsListCalls.length).toBeGreaterThanOrEqual(2);
    expect(pullsListCalls[1].page).toBe(2);
  });

  // W11-12: listOpenPrs used a bare `for(;;)` with no page ceiling. A repo with
  // many open DRAFT PRs (all skipped) and few non-draft PRs, with the cap
  // unfilled, would paginate through every open PR without a ceiling. CORE-4
  // added MAX_PAGES caps to changed-files.js, comments.js, and review.js but
  // schedule.js was missed. The loop must enforce a MAX_PAGES ceiling.
  it('terminates after MAX_PAGES even when the API always returns a full page of drafts (W11-12)', async () => {
    let calls = 0;
    const fullPage = Array.from({ length: 50 }, (_, i) => ({
      number: 1000 + calls * 50 + i,
      head: { sha: 'd' },
      draft: true, // all drafts → all skipped → cap never filled
      title: 'd',
    }));
    const octokit = {
      rest: {
        pulls: {
          async list() {
            calls += 1;
            return { data: [...fullPage].map((p) => ({ ...p, number: 1000 + calls * 50 })) };
          },
        },
      },
    };
    await listOpenPrs({ octokit, owner: 'o', repo: 'r', maxPrs: 100, perPage: 50 });
    // Without a cap this would loop indefinitely (drafts never fill the cap).
    // With the cap it terminates at MAX_PAGES (100).
    expect(calls).toBeLessThanOrEqual(101); // MAX_PAGES + small slack
    expect(calls).toBeGreaterThan(0);
  });
});

/* ---------- hasReviewForSha ---------- */

describe('hasReviewForSha', () => {
  it('returns true when a comment contains the marker AND the head SHA', async () => {
    const octokit = makeOctokit({
      commentsByPr: { 42: [{ body: `## Z.ai Code Review\n\n${MARKER}\n<!-- zai-sha: sha-abc -->`, user: { login: 'github-actions[bot]', type: 'Bot' } }] },
    });
    const found = await hasReviewForSha({ octokit, owner: 'o', repo: 'r', pullNumber: 42, headSha: 'sha-abc' });
    expect(found).toBe(true);
  });

  it('returns false when a marker exists but for a DIFFERENT SHA (re-push)', async () => {
    const octokit = makeOctokit({
      commentsByPr: { 42: [{ body: `old review\n\n${MARKER}\n<!-- zai-sha: sha-old -->`, user: { login: 'github-actions[bot]', type: 'Bot' } }] },
    });
    const found = await hasReviewForSha({ octokit, owner: 'o', repo: 'r', pullNumber: 42, headSha: 'sha-new' });
    expect(found).toBe(false);
  });

  it('returns false when no marker comment exists', async () => {
    const octokit = makeOctokit({ commentsByPr: { 42: [{ body: 'unrelated' }] } });
    const found = await hasReviewForSha({ octokit, owner: 'o', repo: 'r', pullNumber: 42, headSha: 'sha' });
    expect(found).toBe(false);
  });

  // ----- Security: review-suppression via spoofed marker (S1) -----
  // A drive-by commenter (NONE association, type 'User') must NOT be able to
  // post a comment containing the marker + head SHA and thereby cause the
  // scheduled review to SKIP that PR. Only bot-authored marker comments count.
  it('returns FALSE when a non-bot (User) comment contains the marker + SHA (spoof attempt)', async () => {
    const octokit = makeOctokit({
      commentsByPr: {
        42: [
          {
            body: `sneaky suppress\n\n${MARKER}\n\nsha-abc`,
            user: { login: 'attacker', type: 'User' },
          },
        ],
      },
    });
    const found = await hasReviewForSha({ octokit, owner: 'o', repo: 'r', pullNumber: 42, headSha: 'sha-abc' });
    expect(found).toBe(false);
  });

  it('returns TRUE when a bot comment (type Bot) contains the marker + SHA', async () => {
    const octokit = makeOctokit({
      commentsByPr: {
        42: [
          {
            body: `real review\n\n${MARKER}\n<!-- zai-sha: sha-abc -->`,
            user: { login: 'z-ai-code-reviewer[bot]', type: 'Bot' },
          },
        ],
      },
    });
    const found = await hasReviewForSha({ octokit, owner: 'o', repo: 'r', pullNumber: 42, headSha: 'sha-abc' });
    expect(found).toBe(true);
  });

  it('returns TRUE when a bot comment (login ends with [bot]) contains the marker + SHA', async () => {
    // Some bots report type 'Bot' but the type field is not always present;
    // login ending in [bot] is the other signal. Cover both code paths.
    const octokit = makeOctokit({
      commentsByPr: {
        42: [
          {
            body: `real review\n\n${MARKER}\n<!-- zai-sha: sha-abc -->`,
            user: { login: 'github-actions[bot]' },
          },
        ],
      },
    });
    const found = await hasReviewForSha({ octokit, owner: 'o', repo: 'r', pullNumber: 42, headSha: 'sha-abc' });
    expect(found).toBe(true);
  });

  it('returns FALSE when only a non-bot comment carries the marker (SHA unknown fallback)', async () => {
    // When headSha is '' the implementation falls back to marker-only matching;
    // the author check must still apply so an attacker cannot suppress by SHA-less marker.
    const octokit = makeOctokit({
      commentsByPr: {
        42: [
          {
            body: `sneaky\n\n${MARKER}`,
            user: { login: 'attacker', type: 'User' },
          },
        ],
      },
    });
    const found = await hasReviewForSha({ octokit, owner: 'o', repo: 'r', pullNumber: 42, headSha: '' });
    expect(found).toBe(false);
  });

  // ----- INT-3: empty headSha must NOT short-circuit to "already reviewed" -----
  // A bot marker comment with an empty headSha previously caused hasReviewForSha
  // to return true (suppressing the PR). The fix: empty SHA can't confirm
  // SHA-level dedup, so the PR must be reviewed.
  it('returns FALSE when headSha is "" even with a bot marker comment (INT-3)', async () => {
    const octokit = makeOctokit({
      commentsByPr: {
        42: [
          {
            body: `real review\n\n${MARKER}`,
            user: { login: 'github-actions[bot]', type: 'Bot' },
          },
        ],
      },
    });
    const found = await hasReviewForSha({ octokit, owner: 'o', repo: 'r', pullNumber: 42, headSha: '' });
    expect(found).toBe(false);
  });

  // ----- W5-3: dedup must search REVIEWS, not just issue comments -----
  // When findings map to diff lines, reviewOnePr posts a REVIEW via
  // pulls.createReview (not an issue comment). The SHA marker block is embedded
  // in the REVIEW body. hasReviewForSha previously searched ONLY issue comments
  // (issues.listComments), so it never found the marker in a review → every
  // cron tick re-reviewed the same PR at the same SHA.
  it('W5-3: returns TRUE when the marker + SHA lives in a REVIEW (not an issue comment)', async () => {
    const shaBlock = `<!-- zai-sha: sha-abc -->`;
    const octokit = makeOctokit({
      commentsByPr: {}, // no issue comments at all
      reviewsByPr: {
        42: [
          {
            body: `## Z.ai Code Review\n...findings...\n\n${MARKER}\n${shaBlock}`,
            user: { login: 'github-actions[bot]', type: 'Bot' },
          },
        ],
      },
    });
    const found = await hasReviewForSha({ octokit, owner: 'o', repo: 'r', pullNumber: 42, headSha: 'sha-abc' });
    expect(found).toBe(true);
  });

  it('W5-3: returns FALSE when a review exists but for a DIFFERENT SHA', async () => {
    const octokit = makeOctokit({
      reviewsByPr: {
        42: [
          {
            body: `old review\n\n${MARKER}\n<!-- zai-sha: sha-old -->`,
            user: { login: 'github-actions[bot]', type: 'Bot' },
          },
        ],
      },
    });
    const found = await hasReviewForSha({ octokit, owner: 'o', repo: 'r', pullNumber: 42, headSha: 'sha-new' });
    expect(found).toBe(false);
  });

  it('W5-3: paginates reviews fully (marker on a later page is still found)', async () => {
    // Simulate >100 reviews is unrealistic, but the pagination contract must
    // hold: a short first page must NOT terminate the search early.
    const shaBlock = `<!-- zai-sha: sha-abc -->`;
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      body: `review ${i}`,
      user: { login: 'github-actions[bot]', type: 'Bot' },
    }));
    const octokit = {
      rest: {
        pulls: {
          async listReviews(params) {
            const page = params.page ?? 1;
            return { data: page === 1 ? page1 : [{ body: `${MARKER}\n${shaBlock}`, user: { login: 'github-actions[bot]', type: 'Bot' } }] };
          },
        },
        issues: {
          async listComments() { return { data: [] }; },
        },
      },
    };
    const found = await hasReviewForSha({ octokit, owner: 'o', repo: 'r', pullNumber: 42, headSha: 'sha-abc' });
    expect(found).toBe(true);
  });

  // ----- W5-8: spoofing defense-in-depth -----
  // The marker + head SHA are public literals. A DIFFERENT bot with comment
  // access could post a comment containing both and suppress the review.
  // Defense-in-depth: require the EXACT structured SHA block this action emits
  // (<!-- zai-sha: <sha> -->), not a bare substring mention of the SHA. A
  // spoofing bot must now match the exact format, raising the bar without
  // breaking any legitimate marker (which always carries the structured block).
  it('W5-8: a bot comment with a bare SHA substring but NO structured sha block is NOT a match', async () => {
    const octokit = makeOctokit({
      commentsByPr: {
        42: [
          {
            // Spoof: marker + bare SHA mention, but no <!-- zai-sha: ... --> block.
            body: `${MARKER}\nmentioned sha-abc in passing`,
            user: { login: 'other-bot[bot]', type: 'Bot' },
          },
        ],
      },
    });
    const found = await hasReviewForSha({ octokit, owner: 'o', repo: 'r', pullNumber: 42, headSha: 'sha-abc' });
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

  it('skips drafts (excluded by listOpenPrs, never reach the batch)', async () => {
    // CFG-3: drafts are filtered out by listOpenPrs before runScheduledReview
    // sees them, so they do not count toward the cap and are not reviewed.
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
    expect(result.skipped).toBe(0); // draft filtered upstream, not counted as skipped
    expect(s.runStructuredReview).toHaveBeenCalledTimes(1);
  });

  it('skips PRs already reviewed at the current head SHA (dedup)', async () => {
    const octokit = makeOctokit({
      prs: [mkPr(1, 'sha1'), mkPr(2, 'sha2')],
      commentsByPr: {
        1: [{ body: `review for sha1\n\n${MARKER}\n<!-- zai-sha: sha1 -->`, user: { login: 'github-actions[bot]', type: 'Bot' } }], // already reviewed
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

  // W11-10: `largePrFileThreshold` used to be a pure no-op — parsed in config,
  // exported as `isLargePr`, wired through dependencies, but NEVER called. Now
  // reviewSinglePr calls it and logs when a PR exceeds the threshold, so the
  // config knob has an observable effect.
  it('W11-10: logs a large-PR notice when isLargePr returns true', async () => {
    const octokit = makeOctokit({ prs: [mkPr(1, 'sha1')], commentsByPr: {} });
    const callApi = vi.fn(async () => 'review');
    const infoCalls = [];
    const bigStubs = makeStubs({ isLargePr: vi.fn(() => true) });
    await runScheduledReview({
      octokit, owner: 'o', repo: 'r', config: makeConfig(), core: { info: (m) => infoCalls.push(m), warning() {} }, callApi, ...bigStubs,
    });
    // isLargePr was actually CALLED (not just passed through).
    expect(bigStubs.isLargePr).toHaveBeenCalled();
    // An observable log line mentions the large-PR threshold.
    expect(infoCalls.some((m) => /large.*pr|threshold/i.test(m))).toBe(true);
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
