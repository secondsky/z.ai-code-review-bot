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
  MAX_HASH_BLOCK_HASHES,
} from '../src/lib/schedule.js';
import { MARKER, findBotMarkerComments } from '../src/lib/comments.js';
import { partitionFindings } from '../src/lib/diff.js';
import { formatWalkthroughSummary } from '../src/lib/walkthrough.js';
import { filterExcludedFiles } from '../src/lib/changed-files.js';
import { mergeRepoConfig } from '../src/lib/repo-config.js';
import { filterFindingsByLearnings } from '../src/lib/learnings.js';
import {
  formatFindingsAsSummary,
  hashFinding,
  parseFindingsHashBlock,
} from '../src/lib/findings.js';
import { setReviewStatus, buildStatusDescription } from '../src/lib/status.js';
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
  // sent to the API. When page 1 returns a FULL page of 10 drafts (all skipped),
  // the loop must keep paginating to find reviewable PRs.
  // W15-A6-1 update: per_page is now CONSTANT across pages (no dynamic clamp),
  // so this fake models true GitHub semantics — a full page returns exactly
  // `per_page` items. Previously the fake returned 10 items against a requested
  // 10 (the old clamped size); with the constant 50 the equivalent scenario is
  // a FULL 50-item page of drafts, followed by the reviewable PRs.
  it('continues paginating when page 1 is all drafts (W2-1 regression)', async () => {
    // Page 1: a FULL page of 50 drafts (perPage default = 50; all skipped).
    // Page 2: 5 non-draft PRs + a short page to terminate. maxPrs=10.
    const page1 = Array.from({ length: 50 }, (_, i) => ({
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
    const out = await listOpenPrs({ octokit, owner: 'o', repo: 'r', maxPrs: 10, perPage: 50 });
    // Must return the 5 non-draft PRs from page 2 — NOT an empty array.
    expect(out).toHaveLength(5);
    expect(out.every((pr) => pr.draft === false)).toBe(true);
    expect(out.map((pr) => pr.number).sort()).toEqual([200, 201, 202, 203, 204]);
    // And it must have actually requested page 2 (proving it did not terminate
    // after page 1: a full 50-of-50 page is NOT a short page).
    expect(pullsListCalls.length).toBeGreaterThanOrEqual(2);
    expect(pullsListCalls[1].page).toBe(2);
  });

  // W11-12: listOpenPrs used a bare `for(;;)` with no page ceiling. A repo with
  // many open DRAFT PRs (all skipped) and few non-draft PRs, with the cap
  // unfilled, would paginate through every open PR without a ceiling. CORE-4
  // added MAX_PAGES caps to changed-files.js, comments.js, and review.js but
  // schedule.js was missed. The loop must enforce a MAX_PAGES ceiling.
  // W15-A6-1: GitHub paginates by OFFSET ((page-1)*per_page). The dynamic
  // per_page clamp (min(perPage, maxPrs - out.length)) SHRINKS the page size
  // between requests, so page 2 with a smaller per_page re-covers items already
  // seen on page 1 (offset moves by less than the first window) → DUPLICATE PRs
  // in the batch and tail PRs starved. The fix: request a CONSTANT per_page
  // every page; the loop already stops ingesting at maxPrs.
  it('W15-A6-1: requests a constant per_page (offset-window fake → no duplicates, tail PRs included)', async () => {
    // 12 PRs; #1 and #7 (positions 1 and 7) are drafts. maxPrs=10, perPage=50.
    // The fake slices by the true GitHub offset semantics ((page-1)*per_page),
    // so the buggy dynamic clamp produced [2,3,4,5,6,8,9,10,3,4] (10 items,
    // #3/#4 duplicated, #11/#12 starved). The fixed version must return exactly
    // the 10 distinct non-draft PRs including the tail #11/#12.
    const prs = Array.from({ length: 12 }, (_, i) => ({
      number: i + 1,
      head: { sha: `s${i + 1}` },
      draft: i + 1 === 1 || i + 1 === 7,
      title: `PR ${i + 1}`,
    }));
    const octokit = makeOctokit({ prs });
    const out = await listOpenPrs({ octokit, owner: 'o', repo: 'r', maxPrs: 10, perPage: 50 });
    expect(out).toHaveLength(10);
    const numbers = out.map((p) => p.number);
    expect(new Set(numbers).size).toBe(10); // no duplicates
    expect(numbers).toEqual([2, 3, 4, 5, 6, 8, 9, 10, 11, 12]); // tail PRs included
  });

  it('W15-A6-1: terminates on a short page with the constant per_page', async () => {
    // 3 PRs returned while perPage=50 → a single short page must terminate
    // pagination after exactly ONE request (no page 2 fetch).
    const prs = [
      { number: 1, head: { sha: 'a' }, draft: false, title: 'A' },
      { number: 2, head: { sha: 'b' }, draft: false, title: 'B' },
      { number: 3, head: { sha: 'c' }, draft: false, title: 'C' },
    ];
    const octokit = makeOctokit({ prs });
    const out = await listOpenPrs({ octokit, owner: 'o', repo: 'r', maxPrs: 10, perPage: 50 });
    expect(out.map((p) => p.number)).toEqual([1, 2, 3]);
    expect(octokit.__calls.pullsList).toHaveLength(1);
  });

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

  // W15-A6-3: reviewOnePr returns {ok:true, action:'skipped-no-patchable'} when
  // a PR has no patchable files, but runScheduledReview counted EVERY ok as
  // reviewed — so the log said "skipped-no-patchable" while the summary said
  // {reviewed:1}. The skipped-no-patchable action must count as SKIPPED.
  it('W15-A6-3: counts skipped-no-patchable PRs as skipped, not reviewed', async () => {
    const octokit = makeOctokit({ prs: [mkPr(1, 'sha1')], commentsByPr: {} });
    const s = makeStubs({ filterPatchableFiles: vi.fn(() => []) });
    const result = await runScheduledReview({
      octokit, owner: 'o', repo: 'r', config: makeConfig(),
      core: { info() {}, warning() {} }, callApi: vi.fn(), ...s,
    });
    expect(result).toEqual({ reviewed: 0, skipped: 1, failed: 0 });
    expect(s.runStructuredReview).not.toHaveBeenCalled();
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

  // W15-A6-4: the summary-only branch (file-level findings) always used
  // formatFindingsAsSummary, ignoring config.walkthrough — while src/index.js
  // renders formatWalkthroughSummary on the SAME PR when walkthrough is on, so
  // cron runs rendered flat while push runs rendered the walkthrough. Mirror
  // index.js: walkthrough && findings.length > 0 → walkthrough renderer.
  it('W15-A6-4: renders the walkthrough summary when config.walkthrough is true (file-level findings)', async () => {
    const octokit = makeOctokit();
    const core = { info: vi.fn(), warning: vi.fn() };
    const fileLevelFinding = { file: 'a.js', line: null, severity: 'low', title: 'X', description: 'd' };
    const s = makeStubs({
      getChangedFiles: vi.fn(async () => [INLINE_FILE]),
      runStructuredReview: vi.fn(async () => ({
        findings: [fileLevelFinding],
        summary: 'summary only',
        metadata: { totalBatches: 1, totalFindingsBeforeCap: 1, deterministicFindingsCount: 0, batchMetadata: [] },
      })),
      // Real renderer so the posted body reflects what production renders.
      formatWalkthroughSummary: vi.fn(formatWalkthroughSummary),
    });

    const result = await reviewOnePr({
      pr: mkPr(8, 'sha8'),
      octokit, owner: 'o', repo: 'r',
      config: makeConfig({ walkthrough: true }), core, callApi: vi.fn(), ...s,
    });

    expect(result).toEqual({ ok: true, action: 'reviewed' });
    expect(s.formatWalkthroughSummary).toHaveBeenCalledTimes(1);
    // Same call shape as index.js: (keptFindings, patchable, {reviewerName, metadata}).
    const wArgs = s.formatWalkthroughSummary.mock.calls[0];
    expect(wArgs[0]).toEqual([fileLevelFinding]);
    expect(wArgs[2].reviewerName).toBe('Z.ai Code Review');
    expect(wArgs[2].metadata.summary).toBe('summary only');
    // The posted comment body carries the walkthrough structure (collapsible
    // cohort sections + overview), not the flat list.
    const posted = s.upsertReviewComment.mock.calls[0][0];
    expect(posted.body).toContain('<details>');
    expect(posted.body).toContain('📊 Overview');
    // And the flat renderer was NOT used.
    expect(s.formatFindingsAsSummary).not.toHaveBeenCalled();
  });

  it('W15-A6-4: renders the flat summary when walkthrough is false/absent (file-level findings)', async () => {
    const octokit = makeOctokit();
    const core = { info: vi.fn(), warning: vi.fn() };
    const fileLevelFinding = { file: 'a.js', line: null, severity: 'low', title: 'X', description: 'd' };
    const s = makeStubs({
      getChangedFiles: vi.fn(async () => [INLINE_FILE]),
      runStructuredReview: vi.fn(async () => ({
        findings: [fileLevelFinding],
        summary: 'summary only',
        metadata: { totalBatches: 1, totalFindingsBeforeCap: 1, deterministicFindingsCount: 0, batchMetadata: [] },
      })),
      formatWalkthroughSummary: vi.fn(formatWalkthroughSummary),
    });

    await reviewOnePr({
      pr: mkPr(8, 'sha8'),
      octokit, owner: 'o', repo: 'r',
      config: makeConfig({ walkthrough: false }), core, callApi: vi.fn(), ...s,
    });

    expect(s.formatFindingsAsSummary).toHaveBeenCalledTimes(1);
    expect(s.formatWalkthroughSummary).not.toHaveBeenCalled();
    // Flat renderer keeps its (findings, {reviewerName, metadata}) shape.
    const fArgs = s.formatFindingsAsSummary.mock.calls[0];
    expect(fArgs[0]).toEqual([fileLevelFinding]);
    expect(fArgs[1].reviewerName).toBe('Z.ai Code Review');
  });

  it('W15-A6-4: walkthrough renderer is NOT used when there are no findings', async () => {
    // index.js: useWalkthrough = config.walkthrough && keptFindings.length > 0 —
    // a clean review (0 findings) still renders the flat "No issues found"
    // summary, never an empty walkthrough.
    const octokit = makeOctokit();
    const core = { info: vi.fn(), warning: vi.fn() };
    const s = makeStubs({
      formatWalkthroughSummary: vi.fn(formatWalkthroughSummary),
    });
    await reviewOnePr({
      pr: mkPr(8, 'sha8'),
      octokit, owner: 'o', repo: 'r',
      config: makeConfig({ walkthrough: true }), core, callApi: vi.fn(), ...s,
    });
    expect(s.formatFindingsAsSummary).toHaveBeenCalledTimes(1);
    expect(s.formatWalkthroughSummary).not.toHaveBeenCalled();
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

/* ---------- reviewOnePr — W15-A8-4 scheduled/push feature parity ---------- */

// The docs promise scanners, .zai.yml repo config, learnings, commit statuses,
// and walkthrough UNCONDITIONALLY — but the scheduled path historically wired
// none of them (the "KNOWN LIMITATION (W8-3)" comment). These tests pin the
// parity wiring. All new collaborators are injected (DI-first) so the tests
// stay hermetic; src/index.js's schedule branch wires the real functions.
describe('reviewOnePr — W15-A8-4 feature parity', () => {
  it('W15-A8-4a: loads .zai.yml at the head SHA, merges it, and re-filters patchable files by merged path_filters', async () => {
    const generated = { filename: 'generated/x.js', status: 'added', patch: '@@ -1,0 +1,1 @@\n+a\n' };
    const s = makeStubs({
      getChangedFiles: vi.fn(async () => [INLINE_FILE, generated]),
      filterExcludedFiles: vi.fn(filterExcludedFiles), // real glob filtering
      loadRepoConfig: vi.fn(async () => ({ reviews: { path_filters: ['generated/**'] } })),
      mergeRepoConfig, // real merge: path_filters → excludePatterns union
    });

    const result = await reviewOnePr({
      pr: mkPr(21, 'sha21'),
      octokit: makeOctokit(), owner: 'o', repo: 'r',
      config: makeConfig({ repoConfigEnabled: true }),
      core: { info: vi.fn(), warning: vi.fn() }, callApi: vi.fn(), ...s,
    });

    expect(result).toEqual({ ok: true, action: 'reviewed' });
    // Fetched at the PR head SHA via the synthetic context.
    expect(s.loadRepoConfig).toHaveBeenCalledTimes(1);
    const loadArgs = s.loadRepoConfig.mock.calls[0][0];
    expect(loadArgs.headSha).toBe('sha21');
    expect(loadArgs.octokit).toBeDefined();
    expect(loadArgs.context.repo).toEqual({ owner: 'o', repo: 'r' });
    // The merged path_filters re-filtered the patchable set: generated/** was
    // dropped before the structured review ran.
    expect(s.runStructuredReview).toHaveBeenCalledTimes(1);
    expect(s.runStructuredReview.mock.calls[0][0]).toEqual([INLINE_FILE]);
  });

  it('W15-A8-4a: a throwing loadRepoConfig is fail-soft — the review proceeds with no repo config', async () => {
    const s = makeStubs({
      loadRepoConfig: vi.fn(async () => { throw new Error('boom'); }),
      mergeRepoConfig,
    });
    const result = await reviewOnePr({
      pr: mkPr(22, 'sha22'),
      octokit: makeOctokit(), owner: 'o', repo: 'r',
      config: makeConfig({ repoConfigEnabled: true }),
      core: { info: vi.fn(), warning: vi.fn() }, callApi: vi.fn(), ...s,
    });
    expect(result).toEqual({ ok: true, action: 'reviewed' });
    expect(s.runStructuredReview).toHaveBeenCalledTimes(1);
  });

  it('W15-A8-4a: does NOT load .zai.yml when repoConfigEnabled is off (flag honored)', async () => {
    const s = makeStubs({
      loadRepoConfig: vi.fn(async () => { throw new Error('must not be called'); }),
      mergeRepoConfig,
    });
    const result = await reviewOnePr({
      pr: mkPr(23, 'sha23'),
      octokit: makeOctokit(), owner: 'o', repo: 'r',
      config: makeConfig({ repoConfigEnabled: false }),
      core: { info: vi.fn(), warning: vi.fn() }, callApi: vi.fn(), ...s,
    });
    expect(result).toEqual({ ok: true, action: 'reviewed' });
    expect(s.loadRepoConfig).not.toHaveBeenCalled();
  });

  it('W15-A8-4a: returns skipped (no review) when .zai.yml path_filters exclude EVERY patchable file', async () => {
    const s = makeStubs({
      filterExcludedFiles: vi.fn(filterExcludedFiles),
      loadRepoConfig: vi.fn(async () => ({ reviews: { path_filters: ['**/*.js'] } })),
      mergeRepoConfig,
    });
    const result = await reviewOnePr({
      pr: mkPr(24, 'sha24'),
      octokit: makeOctokit(), owner: 'o', repo: 'r',
      config: makeConfig({ repoConfigEnabled: true }),
      core: { info: vi.fn(), warning: vi.fn() }, callApi: vi.fn(), ...s,
    });
    expect(result).toEqual({ ok: true, action: 'skipped-no-patchable' });
    expect(s.runStructuredReview).not.toHaveBeenCalled();
  });

  // A deterministic scanner finding: line-anchored to the INLINE patch so it
  // flows through the inline-review branch (buildReviewComments renders it).
  const SCANNER_FINDING = {
    file: 'a.js',
    line: 2,
    severity: 'critical',
    title: 'Hardcoded AWS key',
    description: 'secret detected',
    rule: 'gitleaks:aws-access-key',
  };
  // Stub that echoes the deterministic findings as the review output, so the
  // test observes the schedule-side WIRING (scanner findings handed to
  // runStructuredReview and rendered into the posted review).
  const echoDeterministic = vi.fn(async (files, cfg) => ({
    findings: Array.isArray(cfg.deterministicFindings) ? cfg.deterministicFindings : [],
    summary: 'scanners',
    metadata: { totalBatches: 1, totalFindingsBeforeCap: 1, deterministicFindingsCount: 1, batchMetadata: [] },
  }));

  it('W15-A8-4b: runs scanners on the changed files and merges scanner findings into the posted review', async () => {
    const s = makeStubs({
      getChangedFiles: vi.fn(async () => [INLINE_FILE]),
      runStructuredReview: echoDeterministic,
      runScanners: vi.fn(async () => ({
        findings: [SCANNER_FINDING],
        metrics: { totalFiles: 1 },
        scannerNames: ['secrets:fake'],
      })),
      formatScannerContext: vi.fn(() => 'SCANNER-CTX'),
    });

    const result = await reviewOnePr({
      pr: mkPr(25, 'sha25'),
      octokit: makeOctokit(), owner: 'o', repo: 'r',
      config: makeConfig(), core: { info: vi.fn(), warning: vi.fn() }, callApi: vi.fn(), ...s,
    });

    expect(result).toEqual({ ok: true, action: 'reviewed' });
    // Scanners ran on the PATCHABLE (changed) files.
    expect(s.runScanners).toHaveBeenCalledTimes(1);
    expect(s.runScanners.mock.calls[0][0].files).toEqual([INLINE_FILE]);
    // The scanner findings + context were handed to the structured review
    // exactly the way src/index.js's push path does.
    expect(s.formatScannerContext).toHaveBeenCalledWith([SCANNER_FINDING], { totalFiles: 1 });
    const reviewCfg = s.runStructuredReview.mock.calls[0][1];
    expect(reviewCfg.deterministicFindings).toEqual([SCANNER_FINDING]);
    expect(reviewCfg.scannerContext).toBe('SCANNER-CTX');
    // And the scanner finding reached the posted inline review.
    expect(s.upsertReview).toHaveBeenCalledTimes(1);
    const comments = s.upsertReview.mock.calls[0][0].comments;
    expect(comments.some((c) => c.body.includes('Hardcoded AWS key'))).toBe(true);
  });

  it('W15-A8-4b: maps .zai.yml scanner toggles onto the orchestrator repoConfig (incl. the metrics key)', async () => {
    const s = makeStubs({
      loadRepoConfig: vi.fn(async () => ({ scanners: { gitleaks: false, metrics: false } })),
      mergeRepoConfig,
      runScanners: vi.fn(async () => ({ findings: [], metrics: {}, scannerNames: [] })),
      formatScannerContext: vi.fn(() => ''),
    });
    await reviewOnePr({
      pr: mkPr(26, 'sha26'),
      octokit: makeOctokit(), owner: 'o', repo: 'r',
      config: makeConfig({ repoConfigEnabled: true }),
      core: { info: vi.fn(), warning: vi.fn() }, callApi: vi.fn(), ...s,
    });
    // gitleaks→secrets and metrics are disabled by the repo; ast_grep→patterns
    // is left to the action default (undefined = not disabled).
    expect(s.runScanners).toHaveBeenCalledTimes(1);
    expect(s.runScanners.mock.calls[0][0].repoConfig.scanners).toEqual({
      secrets: false,
      patterns: undefined,
      metrics: false,
    });
  });

  it('W15-A8-4b: forwards scannersEnabled:false to the orchestrator (flag honored)', async () => {
    const s = makeStubs({
      runScanners: vi.fn(async () => ({ findings: [], metrics: {}, scannerNames: [] })),
      formatScannerContext: vi.fn(() => ''),
    });
    await reviewOnePr({
      pr: mkPr(27, 'sha27'),
      octokit: makeOctokit(), owner: 'o', repo: 'r',
      config: makeConfig({ scannersEnabled: false }),
      core: { info: vi.fn(), warning: vi.fn() }, callApi: vi.fn(), ...s,
    });
    // Mirrors index.js: runScanners is always invoked; the master switch rides
    // opts.config.scannersEnabled and the orchestrator no-ops when it is false.
    expect(s.runScanners.mock.calls[0][0].config.scannersEnabled).toBe(false);
  });

  it('W15-A8-4c: loads learnings, passes learningsContext into the prompt, and suppresses matching findings', async () => {
    const s = makeStubs({
      getChangedFiles: vi.fn(async () => [INLINE_FILE]),
      runStructuredReview: vi.fn(async () => ({
        findings: [INLINE_FINDING],
        summary: 'learnings review',
        metadata: { totalBatches: 1, totalFindingsBeforeCap: 1, deterministicFindingsCount: 0, batchMetadata: [] },
      })),
      loadLearnings: vi.fn(async () => [{ file: 'a.js', pattern: 'Bad' }]),
      formatLearningsForPrompt: vi.fn(() => 'LRN-CTX'),
      filterFindingsByLearnings, // real suppression semantics
      formatFindingsAsSummary: vi.fn(formatFindingsAsSummary), // real renderer
    });

    const result = await reviewOnePr({
      pr: mkPr(28, 'sha28'),
      octokit: makeOctokit(), owner: 'o', repo: 'r',
      config: makeConfig({ learningsEnabled: true }),
      core: { info: vi.fn(), warning: vi.fn() }, callApi: vi.fn(), ...s,
    });

    expect(result).toEqual({ ok: true, action: 'reviewed' });
    // Fetched at the PR head SHA via the synthetic context.
    expect(s.loadLearnings).toHaveBeenCalledTimes(1);
    expect(s.loadLearnings.mock.calls[0][0].headSha).toBe('sha28');
    // The accepted patterns rode the LLM prompt config exactly like index.js.
    expect(s.runStructuredReview.mock.calls[0][1].learningsContext).toBe('LRN-CTX');
    expect(s.formatLearningsForPrompt).toHaveBeenCalledWith([{ file: 'a.js', pattern: 'Bad' }]);
    // The matching finding was suppressed: nothing inline, and the posted
    // summary carries no trace of it.
    expect(s.upsertReview).not.toHaveBeenCalled();
    expect(s.formatFindingsAsSummary).toHaveBeenCalledWith([], expect.anything());
    const posted = s.upsertReviewComment.mock.calls[0][0];
    expect(posted.body).not.toContain('Bad');
  });

  it('W15-A8-4c: a NON-matching learning keeps the finding (no over-suppression)', async () => {
    const s = makeStubs({
      getChangedFiles: vi.fn(async () => [INLINE_FILE]),
      runStructuredReview: vi.fn(async () => ({
        findings: [INLINE_FINDING],
        summary: 'learnings review',
        metadata: { totalBatches: 1, totalFindingsBeforeCap: 1, deterministicFindingsCount: 0, batchMetadata: [] },
      })),
      loadLearnings: vi.fn(async () => [{ file: 'a.js', pattern: 'totally unrelated' }]),
      formatLearningsForPrompt: vi.fn(() => 'LRN-CTX'),
      filterFindingsByLearnings,
    });

    await reviewOnePr({
      pr: mkPr(29, 'sha29'),
      octokit: makeOctokit(), owner: 'o', repo: 'r',
      config: makeConfig({ learningsEnabled: true }),
      core: { info: vi.fn(), warning: vi.fn() }, callApi: vi.fn(), ...s,
    });

    // Kept → inline review still posted with the finding.
    expect(s.upsertReview).toHaveBeenCalledTimes(1);
    const comments = s.upsertReview.mock.calls[0][0].comments;
    expect(comments.some((c) => c.body.includes('Bad'))).toBe(true);
  });

  it('W15-A8-4c: does NOT load learnings when learningsEnabled is off (flag honored)', async () => {
    const s = makeStubs({
      loadLearnings: vi.fn(async () => { throw new Error('must not be called'); }),
    });
    const result = await reviewOnePr({
      pr: mkPr(30, 'sha30'),
      octokit: makeOctokit(), owner: 'o', repo: 'r',
      config: makeConfig({ learningsEnabled: false }),
      core: { info: vi.fn(), warning: vi.fn() }, callApi: vi.fn(), ...s,
    });
    expect(result).toEqual({ ok: true, action: 'reviewed' });
    expect(s.loadLearnings).not.toHaveBeenCalled();
  });

  it('W15-A8-4d: posts a pending status at the start and a success status computed from the final kept findings', async () => {
    const criticalFinding = { ...INLINE_FINDING, severity: 'critical' };
    const s = makeStubs({
      getChangedFiles: vi.fn(async () => [INLINE_FILE]),
      runStructuredReview: vi.fn(async () => ({
        findings: [criticalFinding],
        summary: 'status review',
        metadata: { totalBatches: 1, totalFindingsBeforeCap: 1, deterministicFindingsCount: 0, batchMetadata: [] },
      })),
      setReviewStatus: vi.fn(async () => true),
      buildStatusDescription, // real description builder
    });

    const result = await reviewOnePr({
      pr: mkPr(31, 'sha31'),
      octokit: makeOctokit(), owner: 'o', repo: 'r',
      config: makeConfig({ commitStatus: true }),
      core: { info: vi.fn(), warning: vi.fn() }, callApi: vi.fn(), ...s,
    });

    expect(result).toEqual({ ok: true, action: 'reviewed' });
    expect(s.setReviewStatus).toHaveBeenCalledTimes(2);
    const [pendingArgs] = s.setReviewStatus.mock.calls[0];
    expect(pendingArgs.sha).toBe('sha31');
    expect(pendingArgs.state).toBe('pending');
    expect(pendingArgs.context.repo).toEqual({ owner: 'o', repo: 'r' });
    const [successArgs] = s.setReviewStatus.mock.calls[1];
    expect(successArgs.sha).toBe('sha31');
    expect(successArgs.state).toBe('success');
    // Success description is derived from the FINAL kept findings (1 critical).
    expect(successArgs.description).toBe(
      buildStatusDescription({ findingCount: 1, criticalCount: 1, highCount: 0 }),
    );
  });

  it('W15-A8-4d: the success status reflects learnings suppression (kept set, not raw set)', async () => {
    const criticalFinding = { ...INLINE_FINDING, severity: 'critical', title: 'Bad' };
    const s = makeStubs({
      getChangedFiles: vi.fn(async () => [INLINE_FILE]),
      runStructuredReview: vi.fn(async () => ({
        findings: [criticalFinding],
        summary: 'status review',
        metadata: { totalBatches: 1, totalFindingsBeforeCap: 1, deterministicFindingsCount: 0, batchMetadata: [] },
      })),
      loadLearnings: vi.fn(async () => [{ file: 'a.js', pattern: 'Bad' }]),
      formatLearningsForPrompt: vi.fn(() => 'LRN'),
      filterFindingsByLearnings,
      setReviewStatus: vi.fn(async () => true),
      buildStatusDescription,
    });

    await reviewOnePr({
      pr: mkPr(32, 'sha32'),
      octokit: makeOctokit(), owner: 'o', repo: 'r',
      config: makeConfig({ commitStatus: true, learningsEnabled: true }),
      core: { info: vi.fn(), warning: vi.fn() }, callApi: vi.fn(), ...s,
    });

    expect(s.setReviewStatus).toHaveBeenCalledTimes(2);
    const [successArgs] = s.setReviewStatus.mock.calls[1];
    // The finding was learning-suppressed → the status must say "no issues",
    // not "1 findings" (W15-A6-2 parity: status matches the posted review).
    expect(successArgs.state).toBe('success');
    expect(successArgs.description).toBe('Review complete: no issues found ✅');
  });

  it('W15-A8-4d: posts a TERMINAL success status when .zai.yml path_filters exclude everything (W15-A7-3 parity)', async () => {
    const s = makeStubs({
      filterExcludedFiles: vi.fn(filterExcludedFiles),
      loadRepoConfig: vi.fn(async () => ({ reviews: { path_filters: ['**/*.js'] } })),
      mergeRepoConfig,
      setReviewStatus: vi.fn(async () => true),
    });
    const result = await reviewOnePr({
      pr: mkPr(33, 'sha33'),
      octokit: makeOctokit(), owner: 'o', repo: 'r',
      config: makeConfig({ repoConfigEnabled: true, commitStatus: true }),
      core: { info: vi.fn(), warning: vi.fn() }, callApi: vi.fn(), ...s,
    });
    expect(result).toEqual({ ok: true, action: 'skipped-no-patchable' });
    // pending was posted, then the terminal success — never left spinning.
    const states = s.setReviewStatus.mock.calls.map((c) => c[0].state);
    expect(states).toEqual(['pending', 'success']);
  });

  it('W15-A8-4d: posts NO status for a zero-patchable PR (pending fires only after the patchable check)', async () => {
    const s = makeStubs({
      filterPatchableFiles: vi.fn(() => []),
      setReviewStatus: vi.fn(async () => true),
    });
    const result = await reviewOnePr({
      pr: mkPr(34, 'sha34'),
      octokit: makeOctokit(), owner: 'o', repo: 'r',
      config: makeConfig({ commitStatus: true }),
      core: { info: vi.fn(), warning: vi.fn() }, callApi: vi.fn(), ...s,
    });
    expect(result).toEqual({ ok: true, action: 'skipped-no-patchable' });
    expect(s.setReviewStatus).not.toHaveBeenCalled();
  });

  it('W15-A8-4d: posts NO statuses when commitStatus is off (flag honored)', async () => {
    const s = makeStubs({
      setReviewStatus: vi.fn(async () => true),
    });
    const result = await reviewOnePr({
      pr: mkPr(35, 'sha35'),
      octokit: makeOctokit(), owner: 'o', repo: 'r',
      config: makeConfig({ commitStatus: false }),
      core: { info: vi.fn(), warning: vi.fn() }, callApi: vi.fn(), ...s,
    });
    expect(result).toEqual({ ok: true, action: 'reviewed' });
    expect(s.setReviewStatus).not.toHaveBeenCalled();
  });

  // End-to-end: the batch entry must thread EVERY parity dep into reviewOnePr
  // so a production scheduled run gets scanners + repo config + learnings +
  // statuses + scanner findings in the posted review.
  it('W15-A8-4: runScheduledReview threads the parity deps (scanners, repo config, learnings, statuses) end-to-end', async () => {
    const octokit = makeOctokit({ prs: [mkPr(40, 'sha40')], commentsByPr: {} });
    const core = { info: vi.fn(), warning: vi.fn() };
    const s = makeStubs({
      getChangedFiles: vi.fn(async () => [INLINE_FILE]),
      runStructuredReview: echoDeterministic,
      loadRepoConfig: vi.fn(async () => ({ reviews: {} })),
      mergeRepoConfig,
      loadLearnings: vi.fn(async () => []),
      formatLearningsForPrompt: vi.fn(() => ''),
      filterFindingsByLearnings,
      runScanners: vi.fn(async () => ({
        findings: [SCANNER_FINDING],
        metrics: {},
        scannerNames: ['secrets:fake'],
      })),
      formatScannerContext: vi.fn(() => 'SCANNER-CTX'),
      setReviewStatus: vi.fn(async () => true),
      buildStatusDescription,
    });

    const result = await runScheduledReview({
      octokit, owner: 'o', repo: 'r',
      config: makeConfig({ repoConfigEnabled: true, learningsEnabled: true, commitStatus: true }),
      core, callApi: vi.fn(), ...s,
    });

    expect(result).toEqual({ reviewed: 1, skipped: 0, failed: 0 });
    // Every parity collaborator was reached from the batch entry.
    expect(s.loadRepoConfig).toHaveBeenCalledTimes(1);
    expect(s.loadLearnings).toHaveBeenCalledTimes(1);
    expect(s.runScanners).toHaveBeenCalledTimes(1);
    expect(s.runScanners.mock.calls[0][0].files).toEqual([INLINE_FILE]);
    expect(s.setReviewStatus.mock.calls.map((c) => c[0].state)).toEqual(['pending', 'success']);
    // Scanner findings made it into the posted review.
    const comments = s.upsertReview.mock.calls[0][0].comments;
    expect(comments.some((c) => c.body.includes('Hardcoded AWS key'))).toBe(true);
  });
});

/* ---------- reviewOnePr — W16-B2-1 terminal failure status ---------- */

// reviewOnePr posts `pending` before the heavy review work. If
// runStructuredReview (or anything after pending) throws, the outer catch
// returned {ok:false} with NO terminal status — the check spun `pending`
// forever and a required-check repo was unmergeable until a later lucky tick.
// The catch must post a TERMINAL `failure` status (mirroring what the push
// path's main() does, scoped per-PR) — but ONLY when THIS invocation actually
// posted `pending` (failures before pending — e.g. getChangedFiles — post
// nothing) and only when commitStatus is enabled.
describe('reviewOnePr — W16-B2-1 terminal failure status after pending', () => {
  it('W16-B2-1: posts pending then a TERMINAL failure status when runStructuredReview throws', async () => {
    const s = makeStubs({
      getChangedFiles: vi.fn(async () => [INLINE_FILE]),
      runStructuredReview: vi.fn(async () => {
        throw new Error('LLM exploded');
      }),
      setReviewStatus: vi.fn(async () => true),
      buildStatusDescription,
    });

    const result = await reviewOnePr({
      pr: mkPr(41, 'sha41'),
      octokit: makeOctokit(), owner: 'o', repo: 'r',
      config: makeConfig({ commitStatus: true }),
      core: { info: vi.fn(), warning: vi.fn() }, callApi: vi.fn(), ...s,
    });

    // The PR failure is still reported as {ok:false} (batch isolation).
    expect(result.ok).toBe(false);
    // pending was posted by THIS invocation → a terminal status MUST follow.
    const states = s.setReviewStatus.mock.calls.map((c) => c[0].state);
    expect(states).toEqual(['pending', 'failure']);
    const [failureArgs] = s.setReviewStatus.mock.calls[1];
    expect(failureArgs.sha).toBe('sha41');
    expect(failureArgs.state).toBe('failure');
    expect(failureArgs.description).toMatch(/Z\.ai review failed/i);
    // reviewerName threading + synthetic context, same as the success path.
    expect(failureArgs.reviewerName).toBe('Z.ai Code Review');
    expect(failureArgs.context.repo).toEqual({ owner: 'o', repo: 'r' });
    expect(failureArgs.context.payload.pull_request.number).toBe(41);
  });

  it('W16-B2-1: posts NO statuses when the failure happens BEFORE pending (getChangedFiles throws)', async () => {
    const s = makeStubs({
      getChangedFiles: vi.fn(async () => {
        throw new Error('files API down');
      }),
      setReviewStatus: vi.fn(async () => true),
    });

    const result = await reviewOnePr({
      pr: mkPr(42, 'sha42'),
      octokit: makeOctokit(), owner: 'o', repo: 'r',
      config: makeConfig({ commitStatus: true }),
      core: { info: vi.fn(), warning: vi.fn() }, callApi: vi.fn(), ...s,
    });

    expect(result.ok).toBe(false);
    // pending was never posted by this invocation → no failure status either
    // (mirrors the push path's main(), which only flips statuses it started).
    expect(s.setReviewStatus).not.toHaveBeenCalled();
  });

  it('W16-B2-1: posts NO statuses when commitStatus is off (flag honored)', async () => {
    const s = makeStubs({
      getChangedFiles: vi.fn(async () => [INLINE_FILE]),
      runStructuredReview: vi.fn(async () => {
        throw new Error('LLM exploded');
      }),
      setReviewStatus: vi.fn(async () => true),
    });

    const result = await reviewOnePr({
      pr: mkPr(43, 'sha43'),
      octokit: makeOctokit(), owner: 'o', repo: 'r',
      config: makeConfig({ commitStatus: false }),
      core: { info: vi.fn(), warning: vi.fn() }, callApi: vi.fn(), ...s,
    });

    expect(result.ok).toBe(false);
    expect(s.setReviewStatus).not.toHaveBeenCalled();
  });
});

/* ---------- reviewOnePr — W16-B2-2 scheduled summary preserves the hash block ---------- */

// The scheduled summary path built its comment body with marker + shaBlock
// ONLY; upsertReviewComment replaces the marker comment WHOLESALE, destroying
// the `<!-- zai-hashes:... -->` block a prior push run deposited (regressing
// W15-A8-3: the next push re-reported every unchanged finding). The scheduled
// path must read the existing marker comment's hash block (fail-soft) and
// re-append it, unioned with any hashes this run itself produces.
describe('reviewOnePr — W16-B2-2 preserve hash block across scheduled summaries', () => {
  // parseFindingsHashBlock only honors hex payloads (forged-block defense), so
  // seeded prior hashes must be valid 64-char hex.
  const HEX1 = 'a1b2c3d4'.repeat(8);
  const HEX2 = 'e5f6a7b8'.repeat(8);
  const fileLevelFinding = { file: 'a.js', line: null, severity: 'low', title: 'X', description: 'd' };
  const reviewResult = (findings) => ({
    findings,
    summary: 'summary only',
    metadata: { totalBatches: 1, totalFindingsBeforeCap: findings.length, deterministicFindingsCount: 0, batchMetadata: [] },
  });

  it('W16-B2-2: unions prior marker-comment hashes with this run\'s findings hashes (summary path)', async () => {
    const octokit = makeOctokit({
      commentsByPr: {
        50: [{
          id: 1,
          body:
            '## Z.ai Code Review\n\nprior push summary\n\n' +
            `${MARKER}\n<!-- zai-hashes:${HEX1},${HEX2} -->`,
          user: { login: 'github-actions[bot]', type: 'Bot' },
        }],
      },
    });
    const s = makeStubs({
      getChangedFiles: vi.fn(async () => [INLINE_FILE]),
      runStructuredReview: vi.fn(async () => reviewResult([fileLevelFinding])),
      // Real finder over the fake octokit — the same function src/index.js wires.
      findBotMarkerComments: vi.fn(findBotMarkerComments),
    });

    const result = await reviewOnePr({
      pr: mkPr(50, 'sha50'),
      octokit, owner: 'o', repo: 'r',
      config: makeConfig({ incrementalReview: true }),
      core: { info: vi.fn(), warning: vi.fn() }, callApi: vi.fn(), ...s,
    });

    expect(result).toEqual({ ok: true, action: 'reviewed' });
    const body = s.upsertReviewComment.mock.calls[0][0].body;
    const hashes = parseFindingsHashBlock(body);
    // NOTHING is lost: both prior hashes survive the wholesale replace...
    expect(hashes.has(HEX1)).toBe(true);
    expect(hashes.has(HEX2)).toBe(true);
    // ...and the scheduled run's own finding hash is computed and unioned in
    // (same canonical full-findings-set rule as the push path in index.js).
    expect(hashes.has(hashFinding(fileLevelFinding))).toBe(true);
  });

  it('W16-B2-2: no existing comment → body carries only this run\'s hashes', async () => {
    const octokit = makeOctokit({ commentsByPr: {} });
    const s = makeStubs({
      getChangedFiles: vi.fn(async () => [INLINE_FILE]),
      runStructuredReview: vi.fn(async () => reviewResult([fileLevelFinding])),
      findBotMarkerComments: vi.fn(findBotMarkerComments),
    });

    await reviewOnePr({
      pr: mkPr(51, 'sha51'),
      octokit, owner: 'o', repo: 'r',
      config: makeConfig({ incrementalReview: true }),
      core: { info: vi.fn(), warning: vi.fn() }, callApi: vi.fn(), ...s,
    });

    const body = s.upsertReviewComment.mock.calls[0][0].body;
    const hashes = parseFindingsHashBlock(body);
    expect(hashes.size).toBe(1);
    expect(hashes.has(hashFinding(fileLevelFinding))).toBe(true);
  });

  it('W16-B2-2 → W17-C2-3 (superseded): incrementalReview off → only this run\'s hashes, priors not re-emitted', async () => {
    // SUPERSEDED by W17-C2-3: this test originally asserted that prior
    // hashes were re-emitted even with incrementalReview off (the
    // destruction-free replace). The bounded-union redesign gates prior-hash
    // re-emission on incrementalReview === true (symmetry with index.js):
    // while incremental review is off NOTHING reads hash blocks, so
    // re-emitting an ever-growing prior set was dead weight that grew the
    // comment without bound. With it off the run emits only its OWN hashes
    // (bounded by this run's finding count by construction).
    const octokit = makeOctokit({
      commentsByPr: {
        52: [{
          id: 2,
          body: `prior\n\n${MARKER}\n<!-- zai-hashes:${HEX1} -->`,
          user: { login: 'github-actions[bot]', type: 'Bot' },
        }],
      },
    });
    const s = makeStubs({
      getChangedFiles: vi.fn(async () => [INLINE_FILE]),
      runStructuredReview: vi.fn(async () => reviewResult([fileLevelFinding])),
      findBotMarkerComments: vi.fn(findBotMarkerComments),
    });

    await reviewOnePr({
      pr: mkPr(52, 'sha52'),
      octokit, owner: 'o', repo: 'r',
      config: makeConfig({ incrementalReview: false }),
      core: { info: vi.fn(), warning: vi.fn() }, callApi: vi.fn(), ...s,
    });

    const body = s.upsertReviewComment.mock.calls[0][0].body;
    const hashes = parseFindingsHashBlock(body);
    // Only this run's own hashes are emitted while incremental review is off;
    // the prior set is not re-emitted (and nothing reads it in this mode).
    expect(hashes.size).toBe(1);
    expect(hashes.has(HEX1)).toBe(false);
    expect(hashes.has(hashFinding(fileLevelFinding))).toBe(true);
  });

  it('W16-B2-2: a prior-hash read failure is fail-soft — the review still posts', async () => {
    const s = makeStubs({
      getChangedFiles: vi.fn(async () => [INLINE_FILE]),
      runStructuredReview: vi.fn(async () => reviewResult([fileLevelFinding])),
      findBotMarkerComments: vi.fn(async () => {
        throw new Error('comments API down');
      }),
    });
    const core = { info: vi.fn(), warning: vi.fn() };

    const result = await reviewOnePr({
      pr: mkPr(53, 'sha53'),
      octokit: makeOctokit(), owner: 'o', repo: 'r',
      config: makeConfig({ incrementalReview: true }),
      core, callApi: vi.fn(), ...s,
    });

    expect(result).toEqual({ ok: true, action: 'reviewed' });
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('hash'));
    // The body still carries this run's own hashes (degraded, not broken).
    const body = s.upsertReviewComment.mock.calls[0][0].body;
    expect(parseFindingsHashBlock(body).has(hashFinding(fileLevelFinding))).toBe(true);
  });
});

/* ---------- reviewOnePr — W17-C1-3 skipped-files note ---------- */

// The W16-B3-4 cumulative-cap fix records metadata.skippedFiles but nothing
// consumed it: a scheduled run that silently dropped files still posted a
// bare "No issues found. The changes look good. ✅". The scheduled path must
// thread skippedFiles into its renderers' metadata and surface the drop in
// the posted body — both branches (inline review body + summary comment).
describe('reviewOnePr — W17-C1-3 skipped-files note', () => {
  it('W17-C1-3: summary path renders the skip note alongside the all-clear', async () => {
    const s = makeStubs({
      runStructuredReview: vi.fn(async () => ({
        findings: [],
        summary: '',
        metadata: {
          totalBatches: 0,
          totalFindingsBeforeCap: 0,
          deterministicFindingsCount: 0,
          batchMetadata: [],
          skippedFiles: 2,
          skippedEntries: 2,
        },
      })),
      // Real renderer so the posted body reflects production output (the
      // default stub renderer never emits the all-clear line).
      formatFindingsAsSummary: vi.fn(formatFindingsAsSummary),
    });

    const result = await reviewOnePr({
      pr: mkPr(60, 'sha60'),
      octokit: makeOctokit(), owner: 'o', repo: 'r',
      config: makeConfig(), core: { info: vi.fn(), warning: vi.fn() }, callApi: vi.fn(), ...s,
    });

    expect(result).toEqual({ ok: true, action: 'reviewed' });
    const body = s.upsertReviewComment.mock.calls[0][0].body;
    expect(body).toContain('No issues found');
    expect(body).toContain('2 files not reviewed (MAX_DIFF_CHARS cap).');
  });

  it('W17-C1-3: inline path threads skippedFiles into buildReviewBody metadata and renders the note in the review body', async () => {
    const s = makeStubs({
      getChangedFiles: vi.fn(async () => [INLINE_FILE]),
      runStructuredReview: vi.fn(async () => ({
        findings: [INLINE_FINDING],
        summary: 'inline',
        metadata: {
          totalBatches: 1,
          totalFindingsBeforeCap: 1,
          deterministicFindingsCount: 0,
          batchMetadata: [],
          skippedFiles: 1,
          skippedEntries: 3,
        },
      })),
      // Spy wrapper around the REAL renderer so the metadata threading is
      // observable while the posted body still reflects production output.
      buildReviewBody: vi.fn(buildReviewBody),
    });

    const result = await reviewOnePr({
      pr: mkPr(61, 'sha61'),
      octokit: makeOctokit(), owner: 'o', repo: 'r',
      config: makeConfig(), core: { info: vi.fn(), warning: vi.fn() }, callApi: vi.fn(), ...s,
    });

    expect(result).toEqual({ ok: true, action: 'reviewed' });
    // skippedFiles rides the metadata object alongside truncated/deterministic
    // counts (same threading contract as index.js's reviewMetadata).
    const meta = s.buildReviewBody.mock.calls[0][2];
    expect(meta.skippedFiles).toBe(1);
    expect(typeof meta.truncated).toBe('number');
    const body = s.upsertReview.mock.calls[0][0].body;
    expect(body).toContain('1 file not reviewed (MAX_DIFF_CHARS cap).');
  });

  it('W17-C1-3: zero skipped files → no skip note in the posted body', async () => {
    const s = makeStubs();
    await reviewOnePr({
      pr: mkPr(62, 'sha62'),
      octokit: makeOctokit(), owner: 'o', repo: 'r',
      config: makeConfig(), core: { info: vi.fn(), warning: vi.fn() }, callApi: vi.fn(), ...s,
    });
    const body = s.upsertReviewComment.mock.calls[0][0].body;
    expect(body).not.toContain('not reviewed');
    expect(body).not.toContain('MAX_DIFF_CHARS');
  });
});

/* ---------- reviewOnePr — W17-C2-1 incremental review on the INLINE branch ---------- */

// The W16 hash-block preservation covered the SUMMARY branch only. The INLINE
// branch (dominant whenever any finding maps to a diff line) appended only the
// SHA block — never a hash block — and reviewOnePr never applied
// filterIncrementalFindings, so every cron tick re-reported unchanged findings
// through inline comments. Mirror index.js: read prior marker-comment hashes,
// suppress unchanged findings (incremental BEFORE learnings, exactly like
// index.js), and append a hash block built from the FULL findings set.
describe('reviewOnePr — W17-C2-1 inline hash block + incremental suppression', () => {
  // A second line-mappable finding (line 3 is the second added line of
  // INLINE_PATCH) so the inline branch is taken even when the first finding
  // is suppressed.
  const NEW_FINDING = {
    file: 'a.js',
    line: 3,
    severity: 'medium',
    title: 'Fresh issue',
    description: 'd2',
  };
  const reviewResult = (findings) => ({
    findings,
    summary: 'inline review',
    metadata: { totalBatches: 1, totalFindingsBeforeCap: findings.length, deterministicFindingsCount: 0, batchMetadata: [] },
  });
  const priorMarkerComment = (hashes) => ({
    id: 1,
    body: `prior push summary\n\n${MARKER}\n<!-- zai-hashes:${hashes.join(',')} -->`,
    user: { login: 'github-actions[bot]', type: 'Bot' },
  });

  it('W17-C2-1: prior-reported mappable finding is suppressed and the review body carries a full-set hash block', async () => {
    const octokit = makeOctokit({
      commentsByPr: { 70: [priorMarkerComment([hashFinding(INLINE_FINDING)])] },
    });
    const core = { info: vi.fn(), warning: vi.fn() };
    const s = makeStubs({
      getChangedFiles: vi.fn(async () => [INLINE_FILE]),
      runStructuredReview: vi.fn(async () => reviewResult([INLINE_FINDING, NEW_FINDING])),
      findBotMarkerComments: vi.fn(findBotMarkerComments),
    });

    const result = await reviewOnePr({
      pr: mkPr(70, 'sha70'),
      octokit, owner: 'o', repo: 'r',
      config: makeConfig({ incrementalReview: true }),
      core, callApi: vi.fn(), ...s,
    });

    expect(result).toEqual({ ok: true, action: 'reviewed' });
    // The NEW finding still maps inline → the inline-review branch ran.
    expect(s.upsertReview).toHaveBeenCalledTimes(1);
    expect(s.upsertReviewComment).not.toHaveBeenCalled();
    // Suppression happened (count surfaced via the log, mirroring index.js).
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('suppressed 1 previously-reported finding'),
    );
    // The suppressed finding is NOT re-reported as an inline comment; only
    // the new one is.
    const call = s.upsertReview.mock.calls[0][0];
    expect(call.comments).toHaveLength(1);
    expect(call.comments[0].body).toContain('Fresh issue');
    expect(call.comments.some((c) => c.body.includes(INLINE_FINDING.title))).toBe(false);
    // The posted review body carries a hash block built from the FULL
    // findings set (suppressed or not — index.js's canonical rule).
    expect(call.body).toContain('<!-- zai-hashes:');
    const hashes = parseFindingsHashBlock(call.body);
    expect(hashes.has(hashFinding(INLINE_FINDING))).toBe(true);
    expect(hashes.has(hashFinding(NEW_FINDING))).toBe(true);
  });

  it('W17-C2-1: fully-suppressed mappable finding → summary comment without the finding, still carrying its hash', async () => {
    const octokit = makeOctokit({
      commentsByPr: { 71: [priorMarkerComment([hashFinding(INLINE_FINDING)])] },
    });
    const s = makeStubs({
      getChangedFiles: vi.fn(async () => [INLINE_FILE]),
      runStructuredReview: vi.fn(async () => reviewResult([INLINE_FINDING])),
      findBotMarkerComments: vi.fn(findBotMarkerComments),
      // Real renderer so the posted body reflects production output.
      formatFindingsAsSummary: vi.fn(formatFindingsAsSummary),
    });

    const result = await reviewOnePr({
      pr: mkPr(71, 'sha71'),
      octokit, owner: 'o', repo: 'r',
      config: makeConfig({ incrementalReview: true }),
      core: { info: vi.fn(), warning: vi.fn() }, callApi: vi.fn(), ...s,
    });

    expect(result).toEqual({ ok: true, action: 'reviewed' });
    // Nothing survived suppression → no inline review, summary comment only.
    expect(s.upsertReview).not.toHaveBeenCalled();
    const body = s.upsertReviewComment.mock.calls[0][0].body;
    expect(body).not.toContain(INLINE_FINDING.title);
    expect(parseFindingsHashBlock(body).has(hashFinding(INLINE_FINDING))).toBe(true);
  });

  it('W17-C2-1: incrementalReview false → no suppression and no hash block (index.js canonical rule); prior data untouched', async () => {
    const octokit = makeOctokit({
      commentsByPr: { 72: [priorMarkerComment([hashFinding(INLINE_FINDING)])] },
    });
    const s = makeStubs({
      getChangedFiles: vi.fn(async () => [INLINE_FILE]),
      runStructuredReview: vi.fn(async () => reviewResult([INLINE_FINDING])),
      findBotMarkerComments: vi.fn(findBotMarkerComments),
    });

    const result = await reviewOnePr({
      pr: mkPr(72, 'sha72'),
      octokit, owner: 'o', repo: 'r',
      config: makeConfig({ incrementalReview: false }),
      core: { info: vi.fn(), warning: vi.fn() }, callApi: vi.fn(), ...s,
    });

    expect(result).toEqual({ ok: true, action: 'reviewed' });
    // The finding is reported inline despite the prior hash (no suppression
    // when incremental review is off — mirroring index.js).
    expect(s.upsertReview).toHaveBeenCalledTimes(1);
    const call = s.upsertReview.mock.calls[0][0];
    expect(call.comments).toHaveLength(1);
    expect(call.comments[0].body).toContain(INLINE_FINDING.title);
    // index.js canonical rule: no hash block while incremental review is off.
    expect(call.body).not.toContain('zai-hashes');
    // No data destroyed: the prior marker comment was not replaced.
    expect(s.upsertReviewComment).not.toHaveBeenCalled();
  });
});

/* ---------- reviewOnePr — W17-C2-2 pendingPosted honors setReviewStatus's contract ---------- */

// setReviewStatus is fail-soft and returns FALSE on API failure without
// throwing. pendingPosted was set unconditionally after the await, so a
// pending that never landed still obligated the catch to post a terminal
// failure status — a doomed second 403 (attempts ['pending','failure'] when
// createCommitStatus always 403s). pendingPosted must be set only when
// setReviewStatus resolves TRUE.
describe('reviewOnePr — W17-C2-2 pendingPosted honors the setReviewStatus return contract', () => {
  const statusThrowingOctokit = (attempts) => {
    const octokit = makeOctokit();
    octokit.rest.repos = {
      createCommitStatus: vi.fn(async (params) => {
        attempts.push(params.state);
        throw new Error('403 Resource not accessible by integration');
      }),
    };
    return octokit;
  };

  it('W17-C2-2: pending that never landed (real setReviewStatus, API 403s) → attempts exactly [pending]', async () => {
    const attempts = [];
    const octokit = statusThrowingOctokit(attempts);
    const s = makeStubs({
      getChangedFiles: vi.fn(async () => [INLINE_FILE]),
      runStructuredReview: vi.fn(async () => {
        throw new Error('LLM exploded');
      }),
      // The REAL fail-soft poster — its boolean contract is the seam under
      // test (an injected always-true stub would mask the bug).
      setReviewStatus,
    });

    const result = await reviewOnePr({
      pr: mkPr(45, 'sha45'),
      octokit, owner: 'o', repo: 'r',
      config: makeConfig({ commitStatus: true }),
      core: { info: vi.fn(), warning: vi.fn() }, callApi: vi.fn(), ...s,
    });

    // The review failure is still reported (batch isolation)…
    expect(result.ok).toBe(false);
    // …but only ONE status attempt was made: the failed pending does not
    // obligate a doomed terminal failure post.
    expect(attempts).toEqual(['pending']);
  });

  it('W17-C2-2 regression: working pending + later throw → attempts [pending, failure] (real setReviewStatus)', async () => {
    const attempts = [];
    const octokit = makeOctokit();
    octokit.rest.repos = {
      createCommitStatus: vi.fn(async (params) => {
        attempts.push(params.state);
        return { data: {} };
      }),
    };
    const s = makeStubs({
      getChangedFiles: vi.fn(async () => [INLINE_FILE]),
      runStructuredReview: vi.fn(async () => {
        throw new Error('LLM exploded');
      }),
      setReviewStatus,
    });

    const result = await reviewOnePr({
      pr: mkPr(46, 'sha46'),
      octokit, owner: 'o', repo: 'r',
      config: makeConfig({ commitStatus: true }),
      core: { info: vi.fn(), warning: vi.fn() }, callApi: vi.fn(), ...s,
    });

    expect(result.ok).toBe(false);
    // The pending landed → the catch MUST flip it to a terminal failure
    // (W16-B2-1 behavior preserved under the stricter contract).
    expect(attempts).toEqual(['pending', 'failure']);
  });
});

/* ---------- reviewOnePr — W17-C2-3 bounded hash union ---------- */

// The summary-path hash union (all prior marker-comment hashes ∪ this run's)
// grew WITHOUT bound: every tick with new findings permanently added up to
// maxFindings×65 chars, and past ~65k total the comment update 422s forever.
// The emitted set must be capped (newest-first retention: this run's new
// hashes always survive, then the newest priors), and the prior-hash
// re-emission is gated on incrementalReview (nothing reads hashes while it
// is off, so emitting only the current run's hashes is safe and bounded).
describe('reviewOnePr — W17-C2-3 bounded hash union on the summary path', () => {
  const fileLevelFinding = { file: 'a.js', line: null, severity: 'low', title: 'X', description: 'd' };
  const reviewResult = (findings) => ({
    findings,
    summary: 'summary only',
    metadata: { totalBatches: 1, totalFindingsBeforeCap: findings.length, deterministicFindingsCount: 0, batchMetadata: [] },
  });
  // 700 distinct, parseable 64-char hex hashes (parseFindingsHashBlock only
  // honors hex payloads).
  const manyHashes = Array.from({ length: 700 }, (_, i) =>
    i.toString(16).padStart(64, '0'),
  );
  const priorMarkerComment = (hashes) => ({
    id: 1,
    body: `prior\n\n${MARKER}\n<!-- zai-hashes:${hashes.join(',')} -->`,
    user: { login: 'github-actions[bot]', type: 'Bot' },
  });

  it('W17-C2-3: 700 prior hashes + 1 new finding → block capped at MAX, new hash + newest priors kept, oldest dropped', async () => {
    const octokit = makeOctokit({
      commentsByPr: { 80: [priorMarkerComment(manyHashes)] },
    });
    const s = makeStubs({
      getChangedFiles: vi.fn(async () => [INLINE_FILE]),
      runStructuredReview: vi.fn(async () => reviewResult([fileLevelFinding])),
      findBotMarkerComments: vi.fn(findBotMarkerComments),
    });

    const result = await reviewOnePr({
      pr: mkPr(80, 'sha80'),
      octokit, owner: 'o', repo: 'r',
      config: makeConfig({ incrementalReview: true }),
      core: { info: vi.fn(), warning: vi.fn() }, callApi: vi.fn(), ...s,
    });

    expect(result).toEqual({ ok: true, action: 'reviewed' });
    const body = s.upsertReviewComment.mock.calls[0][0].body;
    // Bounded: the block can never exceed the cap…
    expect(body.length).toBeLessThan(70000);
    const hashes = parseFindingsHashBlock(body);
    expect(hashes.size).toBeLessThanOrEqual(MAX_HASH_BLOCK_HASHES);
    // …and the cap is actually utilized: 1 new hash + (MAX-1) newest priors.
    expect(hashes.size).toBe(MAX_HASH_BLOCK_HASHES);
    // This run's new hash ALWAYS survives…
    expect(hashes.has(hashFinding(fileLevelFinding))).toBe(true);
    // …as do the NEWEST priors (tail of the prior list)…
    expect(hashes.has(manyHashes[manyHashes.length - 1])).toBe(true);
    // …while the OLDEST priors are dropped to fit the cap.
    expect(hashes.has(manyHashes[0])).toBe(false);
  });

  it('W17-C2-3: incrementalReview off → block contains only this run\'s hashes (bounded regardless of prior size)', async () => {
    const octokit = makeOctokit({
      commentsByPr: { 81: [priorMarkerComment(manyHashes)] },
    });
    const s = makeStubs({
      getChangedFiles: vi.fn(async () => [INLINE_FILE]),
      runStructuredReview: vi.fn(async () => reviewResult([fileLevelFinding])),
      findBotMarkerComments: vi.fn(findBotMarkerComments),
    });

    const result = await reviewOnePr({
      pr: mkPr(81, 'sha81'),
      octokit, owner: 'o', repo: 'r',
      config: makeConfig({ incrementalReview: false }),
      core: { info: vi.fn(), warning: vi.fn() }, callApi: vi.fn(), ...s,
    });

    expect(result).toEqual({ ok: true, action: 'reviewed' });
    const body = s.upsertReviewComment.mock.calls[0][0].body;
    const hashes = parseFindingsHashBlock(body);
    // Only this run's own hashes — never the (potentially huge) prior set.
    expect(hashes.size).toBe(1);
    expect(hashes.has(hashFinding(fileLevelFinding))).toBe(true);
    expect(hashes.has(manyHashes[manyHashes.length - 1])).toBe(false);
  });

  it('W17-C2-3: small prior sets are preserved unchanged (no over-trimming)', async () => {
    const hex1 = 'a1b2c3d4'.repeat(8);
    const hex2 = 'e5f6a7b8'.repeat(8);
    const octokit = makeOctokit({
      commentsByPr: { 82: [priorMarkerComment([hex1, hex2])] },
    });
    const s = makeStubs({
      getChangedFiles: vi.fn(async () => [INLINE_FILE]),
      runStructuredReview: vi.fn(async () => reviewResult([fileLevelFinding])),
      findBotMarkerComments: vi.fn(findBotMarkerComments),
    });

    await reviewOnePr({
      pr: mkPr(82, 'sha82'),
      octokit, owner: 'o', repo: 'r',
      config: makeConfig({ incrementalReview: true }),
      core: { info: vi.fn(), warning: vi.fn() }, callApi: vi.fn(), ...s,
    });

    const hashes = parseFindingsHashBlock(s.upsertReviewComment.mock.calls[0][0].body);
    expect(hashes.size).toBe(3);
    expect(hashes.has(hex1)).toBe(true);
    expect(hashes.has(hex2)).toBe(true);
    expect(hashes.has(hashFinding(fileLevelFinding))).toBe(true);
  });
});
