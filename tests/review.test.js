/**
 * Tests for src/lib/review.js — build, submit, and idempotently upsert GitHub
 * reviews with inline line-level comments.
 *
 * The pure builders (buildReviewBody, buildReviewComments, buildReviewPayload)
 * have no I/O. The I/O functions (listBotReviews, dismissStaleReviews,
 * upsertReview, postFallbackComment) are DI-injected via octokit/context, so
 * tests inject a fake octokit whose `rest.pulls.*` methods record every call.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  buildReviewBody,
  buildReviewComments,
  buildReviewPayload,
  resolveReviewEvent,
  listBotReviews,
  dismissStaleReviews,
  upsertReview,
  postFallbackComment,
} from '../src/lib/review.js';
import { MARKER } from '../src/lib/comments.js';

/* ------------------------------------------------------------------ *
 * Pure builders
 * ------------------------------------------------------------------ */

describe('buildReviewBody', () => {
  it('renders the summary prose and the marker', () => {
    const body = buildReviewBody('Looks good.', [], {});
    expect(body).toContain('Looks good.');
    expect(body).toContain(MARKER);
  });

  it('lists summary-only findings in an "Additional findings" section', () => {
    const summaryOnly = [
      { file: 'src/a.js', title: 'Bug here', severity: 'high' },
      { file: 'src/b.js', title: 'Style issue', severity: 'low' },
    ];
    const body = buildReviewBody('Summary.', summaryOnly, {});
    expect(body).toContain('Additional findings');
    expect(body).toContain('src/a.js');
    expect(body).toContain('Bug here');
    expect(body).toContain('src/b.js');
    expect(body).toContain('Style issue');
  });

  it('omits the "Additional findings" section when summaryOnly is empty', () => {
    const body = buildReviewBody('All inline.', [], {});
    expect(body).not.toContain('Additional findings');
  });

  it('includes the marker byte-exact at the end (idempotency detection)', () => {
    const body = buildReviewBody('s', [], {});
    expect(body.endsWith(MARKER)).toBe(true);
  });

  it('includes a deterministic-findings note when metadata says so', () => {
    const body = buildReviewBody('s', [], { deterministicFindingsCount: 3 });
    expect(body).toContain('Scanners found 3');
  });

  it('includes a truncation note when metadata says so', () => {
    const body = buildReviewBody('s', [], { truncated: 2 });
    expect(body).toContain('2 findings truncated');
  });
});

describe('buildReviewComments', () => {
  it('produces one {path, line, side, body} per inline finding', () => {
    const inline = [
      {
        finding: {
          severity: 'high',
          title: 'Null deref',
          description: 'x can be null',
          evidence: 'x.foo()',
          suggestion: 'Guard with if (x)',
        },
        comment: { path: 'src/a.js', line: 10, side: 'RIGHT' },
      },
    ];
    const comments = buildReviewComments(inline);
    expect(comments).toHaveLength(1);
    expect(comments[0].path).toBe('src/a.js');
    expect(comments[0].line).toBe(10);
    expect(comments[0].side).toBe('RIGHT');
    expect(typeof comments[0].body).toBe('string');
  });

  it('renders severity emoji + title + description + evidence + suggestion', () => {
    const inline = [
      {
        finding: {
          severity: 'high',
          title: 'Null deref',
          description: 'x can be null',
          evidence: 'x.foo()',
          suggestion: 'Guard with if (x)',
        },
        comment: { path: 'src/a.js', line: 10, side: 'RIGHT' },
      },
    ];
    const body = buildReviewComments(inline)[0].body;
    expect(body).toContain('🟠'); // high severity emoji
    expect(body).toContain('Null deref');
    expect(body).toContain('x can be null');
    expect(body).toContain('x.foo()');
    expect(body).toContain('Guard with if (x)');
  });

  it('sanitizes the comment body (neutralizes @mentions)', () => {
    const inline = [
      {
        finding: {
          severity: 'low',
          title: 'Spam @everyone',
          description: 'Hey @everyone look',
          evidence: '',
          suggestion: null,
        },
        comment: { path: 'a.js', line: 1, side: 'RIGHT' },
      },
    ];
    const body = buildReviewComments(inline)[0].body;
    // The @mention is neutralized (zero-width space inserted).
    expect(body).not.toMatch(/@everyone/);
    expect(body).toContain('@\u200beveryone');
  });

  it('returns [] for empty input', () => {
    expect(buildReviewComments([])).toEqual([]);
  });

  it('omits the suggestion line when suggestion is null', () => {
    const inline = [
      {
        finding: {
          severity: 'info',
          title: 'Note',
          description: 'fyi',
          evidence: '',
          suggestion: null,
        },
        comment: { path: 'a.js', line: 1, side: 'RIGHT' },
      },
    ];
    const body = buildReviewComments(inline)[0].body;
    expect(body).not.toContain('💡');
  });

  it('escapes backticks in evidence so the inline-code span is preserved (F05)', () => {
    // renderCommentBody wraps evidence in backtick code spans. A backtick in
    // the evidence would close the span early and corrupt the markdown.
    const inline = [
      {
        finding: {
          severity: 'high',
          title: 'Bug',
          description: 'desc',
          evidence: 'evil`injection',
          suggestion: null,
        },
        comment: { path: 'a.js', line: 1, side: 'RIGHT' },
      },
    ];
    const body = buildReviewComments(inline)[0].body;
    // The literal unescaped backtick-in-evidence must NOT appear.
    expect(body).not.toContain('evil`injection');
    // The escaped form should be present.
    expect(body).toContain('evil\\`injection');
  });

  it('collapses newlines in evidence so the code span is preserved and links render as literal text (CORE-2)', () => {
    // A multiline evidence payload containing a markdown link would otherwise
    // break out of the inline-code span and inject a clickable link. The fix
    // collapses newlines to spaces (and escapes backticks) before wrapping.
    const inline = [
      {
        finding: {
          severity: 'high',
          title: 'Bug',
          description: 'desc',
          evidence: 'normal_code\n[Click here](https://evil.com)',
          suggestion: null,
        },
        comment: { path: 'a.js', line: 1, side: 'RIGHT' },
      },
    ];
    const body = buildReviewComments(inline)[0].body;
    // No raw newline inside the evidence portion (the code span is preserved).
    // The whole link text should appear on a single line inside the code span.
    expect(body).not.toMatch(/`normal_code\n/);
    // The link must NOT be a clickable markdown link — it must appear inside
    // the inline-code span as literal text.
    expect(body).toContain('`normal_code [Click here](https://evil.com)`');
    // And no standalone newline splits the evidence from the link.
    expect(body).not.toMatch(/normal_code\r?\n\[Click here\]/);
  });
});

describe('buildReviewPayload', () => {
  it('assembles {body, event, comments} with event defaulting to COMMENT', () => {
    const payload = buildReviewPayload({
      body: 'review body',
      comments: [{ path: 'a.js', line: 1, side: 'RIGHT', body: 'cmt' }],
    });
    expect(payload.event).toBe('COMMENT');
    expect(payload.body).toBe('review body');
    expect(payload.comments).toHaveLength(1);
  });

  it('allows event to be overridden (e.g. REQUEST_CHANGES)', () => {
    const payload = buildReviewPayload({
      body: 'b',
      comments: [],
      event: 'REQUEST_CHANGES',
    });
    expect(payload.event).toBe('REQUEST_CHANGES');
  });

  it('passes the event through unchanged when provided', () => {
    // The caller (index.js) decides the event via resolveReviewEvent; the
    // payload builder must forward whatever it gets verbatim.
    const payload = buildReviewPayload({
      body: 'b',
      comments: [],
      event: 'REQUEST_CHANGES',
    });
    expect(payload.event).toBe('REQUEST_CHANGES');
    // And COMMENT stays COMMENT (no accidental escalation).
    expect(
      buildReviewPayload({ body: 'b', comments: [], event: 'COMMENT' }).event,
    ).toBe('COMMENT');
  });
});

/* ------------------------------------------------------------------ *
 * resolveReviewEvent (Phase 8.3 — strict mode)
 * ------------------------------------------------------------------ */

describe('resolveReviewEvent', () => {
  it('returns COMMENT when strictMode is off (default), regardless of findings', () => {
    const findings = [
      { severity: 'critical' },
      { severity: 'high' },
    ];
    expect(resolveReviewEvent(findings, { strictMode: false })).toBe('COMMENT');
  });

  it('returns COMMENT when strictMode is off even with critical findings', () => {
    // Strict mode is NEVER auto-enabled — the default config has it off.
    expect(resolveReviewEvent([{ severity: 'critical' }], {})).toBe('COMMENT');
    expect(
      resolveReviewEvent([{ severity: 'critical' }], { strictMode: undefined }),
    ).toBe('COMMENT');
  });

  it('returns COMMENT when strictMode is on but no critical/high findings', () => {
    const findings = [
      { severity: 'medium' },
      { severity: 'low' },
      { severity: 'info' },
    ];
    expect(resolveReviewEvent(findings, { strictMode: true })).toBe('COMMENT');
  });

  it('returns COMMENT when strictMode is on but findings is empty', () => {
    expect(resolveReviewEvent([], { strictMode: true })).toBe('COMMENT');
  });

  it('returns REQUEST_CHANGES when strictMode is on and a critical finding exists', () => {
    const findings = [
      { severity: 'low' },
      { severity: 'critical' },
    ];
    expect(resolveReviewEvent(findings, { strictMode: true })).toBe(
      'REQUEST_CHANGES',
    );
  });

  it('returns REQUEST_CHANGES when strictMode is on and a high finding exists', () => {
    const findings = [
      { severity: 'info' },
      { severity: 'high' },
    ];
    expect(resolveReviewEvent(findings, { strictMode: true })).toBe(
      'REQUEST_CHANGES',
    );
  });

  it('returns REQUEST_CHANGES when strictMode is on with a mix including critical', () => {
    const findings = [
      { severity: 'critical' },
      { severity: 'high' },
      { severity: 'medium' },
    ];
    expect(resolveReviewEvent(findings, { strictMode: true })).toBe(
      'REQUEST_CHANGES',
    );
  });

  it('treats a critical finding as the trigger even alongside lower severities', () => {
    // Only ONE critical/high is needed — the rest don't downgrade it.
    const findings = [
      { severity: 'medium' },
      { severity: 'critical' },
      { severity: 'low' },
    ];
    expect(resolveReviewEvent(findings, { strictMode: true })).toBe(
      'REQUEST_CHANGES',
    );
  });

  it('ignores unknown severities (does not crash, does not escalate)', () => {
    const findings = [{ severity: 'tremendous' }];
    expect(resolveReviewEvent(findings, { strictMode: true })).toBe('COMMENT');
  });

  it('handles missing/invalid findings argument gracefully', () => {
    expect(resolveReviewEvent(null, { strictMode: true })).toBe('COMMENT');
    expect(resolveReviewEvent(undefined, { strictMode: true })).toBe('COMMENT');
    expect(resolveReviewEvent('nope', { strictMode: true })).toBe('COMMENT');
  });
});

/* ------------------------------------------------------------------ *
 * I/O functions (fake octokit)
 * ------------------------------------------------------------------ */

/**
 * Build a fake octokit whose rest.pulls.{listReviews, dismissReview,
 * createReview} and rest.issues.createComment record every call.
 */
function makeReviewOctokit({
  reviews = [],
  listReviewsPages = null,
  dismissFailsFor = null,
} = {}) {
  const calls = {
    listReviews: [],
    dismissReview: [],
    createReview: [],
    createComment: [],
  };
  const octokit = {
    rest: {
      pulls: {
        async listReviews(params) {
          calls.listReviews.push(params);
          if (listReviewsPages) {
            const page = params.page ?? 1;
            return { data: listReviewsPages[page - 1] ?? [] };
          }
          return { data: reviews };
        },
        async dismissReview(params) {
          calls.dismissReview.push(params);
          if (dismissFailsFor && dismissFailsFor.includes(params.review_id)) {
            const err = new Error('Validation Failed');
            err.status = 422;
            throw err;
          }
          return { data: {} };
        },
        async createReview(params) {
          calls.createReview.push(params);
          return { data: { id: 999 } };
        },
      },
      issues: {
        async createComment(params) {
          calls.createComment.push(params);
          return { data: { id: 1 } };
        },
      },
    },
  };
  return { octokit, calls };
}

function ctx({ owner = 'o', repo = 'r', number = 42, sha = 'abc123' } = {}) {
  return {
    repo: { owner, repo },
    // pull_request event payloads carry the PR number on `pull_request`; the
    // shared postComment helper reads `payload.issue.number` (issue_comment
    // shape). Including both lets this one context fixture drive every code
    // path under test.
    payload: {
      pull_request: { number, head: { sha } },
      issue: { number },
    },
  };
}

/* ---------- listBotReviews ---------- */

describe('listBotReviews', () => {
  it('paginates fully (per_page=100) until a short page', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      body: 'noise',
      user: { login: 'someone' },
    }));
    const page2 = [
      { id: 200, body: `r\n\n${MARKER}`, user: { login: 'other' } },
    ];
    const { octokit, calls } = makeReviewOctokit({ listReviewsPages: [page1, page2] });

    const out = await listBotReviews({
      octokit,
      context: ctx(),
      marker: MARKER,
    });

    expect(calls.listReviews).toHaveLength(2);
    expect(calls.listReviews[0]).toMatchObject({
      owner: 'o',
      repo: 'r',
      pull_number: 42,
      per_page: 100,
      page: 1,
    });
    expect(out.map((r) => r.id)).toEqual([200]);
  });

  it('filters by marker in body', async () => {
    const reviews = [
      { id: 1, body: 'unrelated', user: { login: 'human' } },
      { id: 2, body: `r\n\n${MARKER}`, user: { login: 'human' } },
    ];
    const { octokit } = makeReviewOctokit({ reviews });
    const out = await listBotReviews({ octokit, context: ctx(), marker: MARKER });
    expect(out.map((r) => r.id)).toEqual([2]);
  });

  it('does NOT match a bare [bot] login when the body lacks the marker (CORE-3)', async () => {
    // A review from any bot (e.g. zai-code-review[bot]) without the marker in
    // its body must NOT be matched — the marker is the canonical idempotency
    // signal. The previous broad `login.endsWith('[bot]')` OR matched ANY bot.
    const reviews = [
      { id: 1, body: 'no marker', user: { login: 'zai-code-review[bot]' } },
      { id: 2, body: 'no marker', user: { login: 'human' } },
    ];
    const { octokit } = makeReviewOctokit({ reviews });
    const out = await listBotReviews({ octokit, context: ctx(), marker: MARKER });
    expect(out.map((r) => r.id)).toEqual([]);
  });

  it('returns only marker-matching reviews (marker is sufficient for idempotency)', async () => {
    const reviews = [
      { id: 1, body: `m\n\n${MARKER}`, user: { login: 'human' } }, // marker
      { id: 2, body: 'x', user: { login: 'github-actions[bot]' } }, // bot login only — excluded
      { id: 3, body: 'x', user: { login: 'human2' } }, // neither — excluded
    ];
    const { octokit } = makeReviewOctokit({ reviews });
    const out = await listBotReviews({ octokit, context: ctx(), marker: MARKER });
    expect(out.map((r) => r.id).sort()).toEqual([1]);
  });

  it('excludes dependabot[bot] reviews that lack the marker (CORE-3)', async () => {
    // Dependabot posts reviews without our marker; they must NOT be dismissed
    // as stale Z.ai reviews. Only marker-bearing reviews are touched.
    const reviews = [
      { id: 7, body: 'Bump lodash from 4.17.20 to 4.17.21', user: { login: 'dependabot[bot]' } },
      { id: 8, body: `zai review\n\n${MARKER}`, user: { login: 'zai-code-review[bot]' } },
    ];
    const { octokit } = makeReviewOctokit({ reviews });
    const out = await listBotReviews({ octokit, context: ctx(), marker: MARKER });
    expect(out.map((r) => r.id)).toEqual([8]);
  });

  it('stops paginating once a short page is seen (no infinite loop)', async () => {
    // A single page with 3 items (< per_page=100) → loop terminates.
    const reviews = [
      { id: 1, body: 'x', user: { login: 'u' } },
      { id: 2, body: 'y', user: { login: 'u' } },
    ];
    const { octokit, calls } = makeReviewOctokit({ reviews });
    await listBotReviews({ octokit, context: ctx(), marker: MARKER });
    expect(calls.listReviews).toHaveLength(1);
  });
});

/* ---------- dismissStaleReviews ---------- */

describe('dismissStaleReviews', () => {
  it('calls dismissReview for each prior review with the reason', async () => {
    const reviews = [
      { id: 11, body: 'x', user: { login: 'bot[bot]' } },
      { id: 22, body: 'y', user: { login: 'bot[bot]' } },
    ];
    const { octokit, calls } = makeReviewOctokit({ reviews });

    await dismissStaleReviews({
      octokit,
      context: ctx({ sha: 'deadbeef' }),
      reviews,
      reason: 'Superseded by re-review at deadbeef',
    });

    expect(calls.dismissReview).toHaveLength(2);
    expect(calls.dismissReview[0]).toMatchObject({
      owner: 'o',
      repo: 'r',
      pull_number: 42,
      review_id: 11,
      message: 'Superseded by re-review at deadbeef',
    });
    expect(calls.dismissReview[1].review_id).toBe(22);
  });

  it('tolerates individual dismiss failures (422) and continues', async () => {
    const reviews = [
      { id: 1, body: 'x', user: { login: 'b[bot]' } },
      { id: 2, body: 'y', user: { login: 'b[bot]' } },
      { id: 3, body: 'z', user: { login: 'b[bot]' } },
    ];
    // review id 2 throws a 422 (already dismissed).
    const { octokit, calls } = makeReviewOctokit({
      reviews,
      dismissFailsFor: [2],
    });
    const core = { info: vi.fn(), warning: vi.fn() };

    await expect(
      dismissStaleReviews({
        octokit,
        context: ctx(),
        reviews,
        reason: 'r',
        core,
      }),
    ).resolves.toBeUndefined();

    // All three were attempted despite the middle one failing.
    expect(calls.dismissReview.map((c) => c.review_id)).toEqual([1, 2, 3]);
    expect(core.warning).toHaveBeenCalled();
  });

  it('handles an empty reviews list (no-op)', async () => {
    const { octokit, calls } = makeReviewOctokit({});
    await dismissStaleReviews({
      octokit,
      context: ctx(),
      reviews: [],
      reason: 'r',
    });
    expect(calls.dismissReview).toHaveLength(0);
  });
});

/* ---------- upsertReview ---------- */

describe('upsertReview', () => {
  it('lists → dismisses → creates in order, returns id + counts', async () => {
    const existing = [
      { id: 5, body: `old\n\n${MARKER}`, user: { login: 'h' } },
    ];
    const { octokit, calls } = makeReviewOctokit({ reviews: existing });

    const result = await upsertReview({
      octokit,
      context: ctx({ sha: 'sha1' }),
      marker: MARKER,
      sha: 'sha1',
      body: 'new review',
      comments: [{ path: 'a.js', line: 1, side: 'RIGHT', body: 'c' }],
    });

    expect(result).toEqual({ id: 999, commentCount: 1, dismissedCount: 1 });
    // Order: listReviews, dismissReview, createReview.
    expect(calls.listReviews).toHaveLength(1);
    expect(calls.dismissReview).toHaveLength(1);
    expect(calls.dismissReview[0].review_id).toBe(5);
    expect(calls.createReview).toHaveLength(1);
    expect(calls.createReview[0]).toMatchObject({
      owner: 'o',
      repo: 'r',
      pull_number: 42,
      body: 'new review',
      event: 'COMMENT',
      comments: [{ path: 'a.js', line: 1, side: 'RIGHT', body: 'c' }],
    });
  });

  it('passes event through to createReview', async () => {
    const { octokit, calls } = makeReviewOctokit({ reviews: [] });
    await upsertReview({
      octokit,
      context: ctx(),
      marker: MARKER,
      sha: 's',
      body: 'b',
      comments: [],
      event: 'REQUEST_CHANGES',
    });
    expect(calls.createReview[0].event).toBe('REQUEST_CHANGES');
  });

  it('defaults event to COMMENT when not provided', async () => {
    const { octokit, calls } = makeReviewOctokit({ reviews: [] });
    await upsertReview({
      octokit,
      context: ctx(),
      marker: MARKER,
      sha: 's',
      body: 'b',
      comments: [],
    });
    expect(calls.createReview[0].event).toBe('COMMENT');
  });

  it('dismisses with a reason referencing the new SHA', async () => {
    const existing = [{ id: 9, body: `x\n\n${MARKER}`, user: { login: 'h' } }];
    const { octokit, calls } = makeReviewOctokit({ reviews: existing });
    await upsertReview({
      octokit,
      context: ctx({ sha: 'feedface' }),
      marker: MARKER,
      sha: 'feedface',
      body: 'b',
      comments: [],
    });
    expect(calls.dismissReview[0].message).toContain('feedface');
  });
});

/* ---------- postFallbackComment ---------- */

describe('postFallbackComment', () => {
  it('delegates to postComment (creates an issue comment)', async () => {
    const { octokit, calls } = makeReviewOctokit({});
    await postFallbackComment({
      octokit,
      context: ctx(),
      body: 'fallback body',
    });
    expect(calls.createComment).toHaveLength(1);
    expect(calls.createComment[0]).toMatchObject({
      owner: 'o',
      repo: 'r',
      issue_number: 42,
    });
    // postComment sanitizes the body; the raw text survives (no markers here).
    expect(calls.createComment[0].body).toContain('fallback body');
  });

  it('returns the result of postComment', async () => {
    const { octokit } = makeReviewOctokit({});
    const result = await postFallbackComment({
      octokit,
      context: ctx(),
      body: 'b',
    });
    // The fake createComment returns { id: 1 }.
    expect(result).toMatchObject({ id: 1 });
  });
});
