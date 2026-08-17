/**
 * Tests for src/lib/comments.js — idempotent marker-based comment upsert.
 *
 * Octokit and `core` are injected (parameters), never imported. Stubs capture
 * calls so we verify real behavior of the upsert branching logic.
 */
import {
  upsertReviewComment,
  buildCommentBody,
  findBotMarkerComment,
  findBotMarkerComments,
  collectPages,
  isBotAuthor,
  MARKER,
} from '../src/lib/comments.js';

/* ---------- Fake octokit helpers ---------- */

/**
 * Build a fake octokit whose rest.issues.{listComments,updateComment,createComment}
 * are stubs recording every call. The listComments resolver returns the
 * configured array (or throws).
 *
 * Pass `paginated: { perPage, pages }` where `pages` is an array of arrays
 * (one per page) to exercise the pagination loop: page N returns pages[N-1].
 */
function makeOctokit({ list = [], throwOnList = null, paginated = null } = {}) {
  const calls = { listComments: [], updateComment: [], createComment: [] };

  const octokit = {
    rest: {
      issues: {
        async listComments(params) {
          calls.listComments.push(params);
          if (throwOnList) {
            throw throwOnList;
          }
          if (paginated) {
            const page = params.page ?? 1;
            return { data: paginated.pages[page - 1] ?? [] };
          }
          return { data: list };
        },
        async updateComment(params) {
          calls.updateComment.push(params);
          return { data: { id: params.comment_id } };
        },
        async createComment(params) {
          calls.createComment.push(params);
          return { data: { id: 999 } };
        },
      },
    },
  };

  return { octokit, calls };
}

function makeComment(id, body, user = undefined) {
  return { id, body, ...(user ? { user } : {}) };
}

/** A typical bot author (GitHub Actions app bot). */
const BOT_USER = { login: 'github-actions[bot]', type: 'Bot' };
/** A typical human / drive-by commenter. */
const HUMAN_USER = { login: 'someuser', type: 'User' };

describe('MARKER', () => {
  test('is the expected hidden HTML comment string', () => {
    expect(MARKER).toBe('<!-- zai-code-review -->');
  });
});

describe('buildCommentBody', () => {
  test('formats with title + content + marker', () => {
    const out = buildCommentBody({ title: 'Summary', content: 'body text', marker: '<!-- m -->' });
    expect(out).toBe(`## Summary\n\nbody text\n\n<!-- m -->`);
  });

  test('without title, omits the heading line', () => {
    const out = buildCommentBody({ content: 'body text', marker: '<!-- m -->' });
    expect(out).toBe(`body text\n\n<!-- m -->`);
  });

  test('sanitizes model content (neutralizes @mentions) while preserving title + marker', () => {
    const out = buildCommentBody({
      title: 'Z.ai Code Review',
      content: 'Hey @spammer see this',
      marker: '<!-- zai-code-review -->',
    });
    expect(out.startsWith('## Z.ai Code Review\n\n')).toBe(true);
    expect(out.endsWith('\n\n<!-- zai-code-review -->')).toBe(true);
    expect(out).toContain('@\u200bspammer');
  });

  test('sanitizes model content (neutralizes GitHub alert banners)', () => {
    const out = buildCommentBody({
      title: 'T',
      content: '> [!WARNING]\n> pre-approved',
      marker: '<!-- m -->',
    });
    expect(out).not.toContain('[!WARNING]');
  });

  // W5-9: when `content` already starts with the `## <title>` heading and ends
  // with the marker (as formatFindingsAsSummary/formatWalkthroughSummary emit),
  // buildCommentBody must NOT prepend another heading or append another marker.
  // Previously the summary path rendered a PR comment with a duplicate H2
  // heading and a duplicate trailing HTML-comment marker.
  test('W5-9: does not duplicate heading when content already starts with it', () => {
    const marker = '<!-- zai-code-review -->';
    const content = `## Z.ai Code Review\n\n### Summary\n\n- a\n\n${marker}`;
    const out = buildCommentBody({ title: 'Z.ai Code Review', content, marker });
    const headingCount = (out.match(/^## /gm) || []).length;
    const markerCount = (out.match(/<!-- zai-code-review -->/g) || []).length;
    expect(headingCount).toBe(1);
    expect(markerCount).toBe(1);
  });

  test('W5-9: still adds heading when content does NOT start with it', () => {
    // Regression guard: plain content (no embedded heading) still gets one.
    const marker = '<!-- m -->';
    const out = buildCommentBody({ title: 'Summary', content: 'body text', marker });
    expect(out).toBe(`## Summary\n\nbody text\n\n${marker}`);
  });

  // W11-8: the heading-detection used `startsWith('## Title\n')` exactly. A
  // heading with incidental trailing whitespace before the newline
  // (`## Title \n`) failed the check, so the content was re-wrapped and the
  // rendered comment showed a DUPLICATE H2 heading.
  test('W11-8: does not duplicate heading when content heading has trailing whitespace', () => {
    const marker = '<!-- zai-code-review -->';
    const content = `## Z.ai Code Review \n\nFindings.\n\n${marker}`;
    const out = buildCommentBody({ title: 'Z.ai Code Review', content, marker });
    const headingCount = (out.match(/^## /gm) || []).length;
    expect(headingCount).toBe(1);
  });

  // W12-3b: when content starts with the heading but does NOT end with the
  // marker, the code fell through to re-wrapping, producing a duplicate H2.
  test('W12-3b: does not duplicate heading when content has heading but no trailing marker', () => {
    const marker = '<!-- m -->';
    const out = buildCommentBody({ title: 'X', content: '## X\nbody', marker });
    const headingCount = (out.match(/^## /gm) || []).length;
    expect(headingCount).toBe(1);
    expect(out).toContain('body');
    expect(out.endsWith(marker)).toBe(true);
  });

  // W13-1: when content is a single line (no newline) equal to the heading,
  // the firstLine extraction used indexOf('\n')=-1 → Math.max(0,-1)=0 → ''.
  // The heading check failed, producing a duplicate H2.
  test('W13-1: does not duplicate heading when content is a single-line heading', () => {
    const marker = '<!-- m -->';
    const out = buildCommentBody({ title: 'T', content: '## T', marker });
    const headingCount = (out.match(/^## /gm) || []).length;
    expect(headingCount).toBe(1);
    expect(out.endsWith(marker)).toBe(true);
  });
});

describe('upsertReviewComment', () => {
  const base = { owner: 'o', repo: 'r', issueNumber: 42, body: 'hello', marker: '<!-- zai-code-review -->' };

  test('creates a comment when none exists with the marker', async () => {
    const { octokit, calls } = makeOctokit({ list: [makeComment(1, 'unrelated')] });
    const core = { info() {} };

    const result = await upsertReviewComment({ ...base, octokit, core });

    expect(result).toEqual({ action: 'created', commentId: 999 });
    expect(calls.createComment).toHaveLength(1);
    expect(calls.createComment[0]).toEqual({
      owner: 'o',
      repo: 'r',
      issue_number: 42,
      body: 'hello',
    });
    expect(calls.updateComment).toHaveLength(0);
  });

  test('updates the existing comment that contains the marker', async () => {
    const existing = makeComment(7, `prior review\n\n${MARKER}`, BOT_USER);
    const { octokit, calls } = makeOctokit({ list: [makeComment(1, 'noise'), existing] });
    const core = { info() {} };

    const result = await upsertReviewComment({ ...base, octokit, core });

    expect(result).toEqual({ action: 'updated', commentId: 7 });
    expect(calls.updateComment).toHaveLength(1);
    expect(calls.updateComment[0]).toEqual({
      owner: 'o',
      repo: 'r',
      comment_id: 7,
      body: 'hello',
    });
    expect(calls.createComment).toHaveLength(0);
  });

  test('listComments called with owner/repo/issue_number, per_page:100, page:1', async () => {
    const { octokit, calls } = makeOctokit({ list: [] });
    await upsertReviewComment({ ...base, octokit });
    expect(calls.listComments).toHaveLength(1);
    expect(calls.listComments[0]).toEqual({
      owner: 'o',
      repo: 'r',
      issue_number: 42,
      per_page: 100,
      page: 1,
    });
  });

  test('paginates fully and finds a marker buried past the first 100 comments', async () => {
    // Page 1: 100 comments, none with marker. Page 2: marker is comment #145.
    const page1 = Array.from({ length: 100 }, (_, i) =>
      makeComment(i + 1, 'unrelated comment'),
    );
    const page2 = [
      ...Array.from({ length: 44 }, (_, i) => makeComment(101 + i, 'noise')),
      makeComment(145, `buried review\n\n${MARKER}`, BOT_USER),
    ];
    const { octokit, calls } = makeOctokit({
      paginated: { perPage: 100, pages: [page1, page2] },
    });

    const result = await upsertReviewComment({ ...base, octokit });

    expect(result).toEqual({ action: 'updated', commentId: 145 });
    expect(calls.listComments).toHaveLength(2);
    expect(calls.listComments[0].page).toBe(1);
    expect(calls.listComments[1].page).toBe(2);
    expect(calls.updateComment[0].comment_id).toBe(145);
    expect(calls.createComment).toHaveLength(0);
  });

  test('stops paginating once the marker is found on an early page', async () => {
    const page1 = [makeComment(5, `early marker\n\n${MARKER}`, BOT_USER)];
    const { octokit, calls } = makeOctokit({
      paginated: { perPage: 100, pages: [page1, [makeComment(6, 'x')]] },
    });
    await upsertReviewComment({ ...base, octokit });
    expect(calls.listComments).toHaveLength(1); // did not fetch page 2
  });

  test('stops paginating at the last (short) page when no marker exists', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => makeComment(i + 1, 'x'));
    const page2 = Array.from({ length: 30 }, (_, i) => makeComment(101 + i, 'y'));
    const { octokit, calls } = makeOctokit({
      paginated: { perPage: 100, pages: [page1, page2] },
    });
    const result = await upsertReviewComment({ ...base, octokit });
    expect(result.action).toBe('created');
    expect(calls.listComments).toHaveLength(2); // stopped after short page 2
  });

  test('updates only the FIRST comment matching the marker when several do', async () => {
    const first = makeComment(11, `one\n\n${MARKER}`, BOT_USER);
    const second = makeComment(22, `two\n\n${MARKER}`, BOT_USER);
    const { octokit, calls } = makeOctokit({ list: [first, second] });

    const result = await upsertReviewComment({ ...base, octokit });

    expect(result).toEqual({ action: 'updated', commentId: 11 });
    expect(calls.updateComment[0].comment_id).toBe(11);
  });

  test('listComments rejection propagates (not swallowed)', async () => {
    const boom = new Error('api down');
    const { octokit } = makeOctokit({ throwOnList: boom });

    await expect(upsertReviewComment({ ...base, octokit })).rejects.toBe(boom);
  });

  test('defaults marker to MARKER constant when not provided', async () => {
    const existing = makeComment(5, `review\n\n${MARKER}`, BOT_USER);
    const { octokit, calls } = makeOctokit({ list: [existing] });

    const { marker: _omitted, ...rest } = base;
    const result = await upsertReviewComment({ ...rest, octokit });

    expect(result).toEqual({ action: 'updated', commentId: 5 });
    expect(calls.updateComment).toHaveLength(1);
  });

  test('core.info is invoked when core is provided (create path)', async () => {
    const infoCalls = [];
    const core = { info: (msg) => infoCalls.push(msg) };
    const { octokit } = makeOctokit({ list: [] });

    await upsertReviewComment({ ...base, octokit, core });

    expect(infoCalls.length).toBe(1);
    expect(infoCalls[0]).toMatch(/creat/i);
  });

  test('core.info is invoked when core is provided (update path)', async () => {
    const infoCalls = [];
    const core = { info: (msg) => infoCalls.push(msg) };
    const existing = makeComment(3, `${MARKER}`, BOT_USER);
    const { octokit } = makeOctokit({ list: [existing] });

    await upsertReviewComment({ ...base, octokit, core });

    expect(infoCalls.length).toBe(1);
    expect(infoCalls[0]).toMatch(/updat/i);
  });

  test('omits core gracefully (no throw) when not provided', async () => {
    const { octokit } = makeOctokit({ list: [] });
    await expect(upsertReviewComment({ ...base, octokit })).resolves.toEqual({
      action: 'created',
      commentId: 999,
    });
  });

  // ----- Security: comment hijack via spoofed marker (F03) -----
  // A non-bot user posting a comment containing the marker must NOT cause the
  // bot to overwrite that comment on every run (which would let an attacker
  // hijack the bot's review thread). Only bot-authored marker comments are
  // eligible for in-place update.
  test('does NOT match a marker in a non-bot (User) comment — creates a new comment instead', async () => {
    const spoofed = makeComment(7, `attacker review\n\n${MARKER}`, HUMAN_USER);
    const { octokit, calls } = makeOctokit({ list: [spoofed] });

    const result = await upsertReviewComment({ ...base, octokit });

    // Must CREATE (not update): the spoofed comment is ignored.
    expect(result).toEqual({ action: 'created', commentId: 999 });
    expect(calls.createComment).toHaveLength(1);
    expect(calls.updateComment).toHaveLength(0);
  });

  test('matches a marker in a bot-authored comment (type Bot) — updates in place', async () => {
    const existing = makeComment(8, `prior review\n\n${MARKER}`, BOT_USER);
    const { octokit, calls } = makeOctokit({ list: [existing] });

    const result = await upsertReviewComment({ ...base, octokit });

    expect(result).toEqual({ action: 'updated', commentId: 8 });
    expect(calls.updateComment).toHaveLength(1);
    expect(calls.updateComment[0].comment_id).toBe(8);
    expect(calls.createComment).toHaveLength(0);
  });

  test('matches a marker in a bot-authored comment (login ends with [bot]) — updates in place', async () => {
    // Covers the login-suffix code path (type field absent).
    const existing = makeComment(9, `prior review\n\n${MARKER}`, { login: 'z-ai-code-reviewer[bot]' });
    const { octokit, calls } = makeOctokit({ list: [existing] });

    const result = await upsertReviewComment({ ...base, octokit });

    expect(result).toEqual({ action: 'updated', commentId: 9 });
    expect(calls.updateComment).toHaveLength(1);
    expect(calls.createComment).toHaveLength(0);
  });

  test('ignores a non-bot marker comment but still updates a later bot marker comment', async () => {
    // Ordering matters: the spoofed (human) comment appears FIRST, but must be
    // skipped; the bot comment (second) is the one that gets updated.
    const spoofed = makeComment(10, `fake\n\n${MARKER}`, HUMAN_USER);
    const real = makeComment(11, `real\n\n${MARKER}`, BOT_USER);
    const { octokit, calls } = makeOctokit({ list: [spoofed, real] });

    const result = await upsertReviewComment({ ...base, octokit });

    expect(result).toEqual({ action: 'updated', commentId: 11 });
    expect(calls.updateComment[0].comment_id).toBe(11);
    expect(calls.createComment).toHaveLength(0);
  });
});

describe('findBotMarkerComment', () => {
  // W15-A8-3: the incremental-review suppression reads prior finding hashes
  // from the bot's marker ISSUE COMMENT when no prior REVIEW carries them
  // (file-level findings are posted as the summary comment, not a review).
  // The finder must expose the same pagination + bot-authority gating as the
  // upsert path so a human comment can never feed suppression.
  const base = { owner: 'o', repo: 'r', issueNumber: 42 };

  test('returns the bot-authored marker comment (with body) when present', async () => {
    const existing = makeComment(7, `prior review\n\n${MARKER}\n<!-- zai-hashes:abc -->`, BOT_USER);
    const { octokit } = makeOctokit({ list: [makeComment(1, 'noise'), existing] });

    const found = await findBotMarkerComment({ ...base, octokit });

    expect(found).not.toBeNull();
    expect(found.id).toBe(7);
    expect(found.body).toContain('<!-- zai-hashes:abc -->');
  });

  test('returns null when no comments exist', async () => {
    const { octokit } = makeOctokit({ list: [] });
    expect(await findBotMarkerComment({ ...base, octokit })).toBeNull();
  });

  test('returns null when no comment carries the marker at all', async () => {
    const { octokit } = makeOctokit({
      list: [makeComment(1, 'plain'), makeComment(2, 'still no marker', BOT_USER)],
    });
    expect(await findBotMarkerComment({ ...base, octokit })).toBeNull();
  });

  test('does NOT match a marker in a human (User) comment — bot-authority gate', async () => {
    const spoofed = makeComment(9, `attacker\n\n${MARKER}\n<!-- zai-hashes:FORGED -->`, HUMAN_USER);
    const { octokit } = makeOctokit({ list: [spoofed] });

    expect(await findBotMarkerComment({ ...base, octokit })).toBeNull();
  });

  test('matches a bot comment via the [bot] login suffix (type absent)', async () => {
    const existing = makeComment(12, `review\n\n${MARKER}`, { login: 'z-ai-reviewer[bot]' });
    const { octokit } = makeOctokit({ list: [existing] });

    const found = await findBotMarkerComment({ ...base, octokit });
    expect(found?.id).toBe(12);
  });

  test('paginates fully and finds a marker buried past the first 100 comments', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => makeComment(i + 1, 'x'));
    const page2 = [
      ...Array.from({ length: 44 }, (_, i) => makeComment(101 + i, 'y')),
      makeComment(145, `buried\n\n${MARKER}`, BOT_USER),
    ];
    const { octokit, calls } = makeOctokit({ paginated: { perPage: 100, pages: [page1, page2] } });

    const found = await findBotMarkerComment({ ...base, octokit });

    expect(found?.id).toBe(145);
    expect(calls.listComments).toHaveLength(2);
    expect(calls.listComments[0].page).toBe(1);
    expect(calls.listComments[1].page).toBe(2);
  });

  test('stops paginating once the marker is found on an early page', async () => {
    const page1 = [makeComment(5, `early\n\n${MARKER}`, BOT_USER)];
    const { octokit, calls } = makeOctokit({
      paginated: { perPage: 100, pages: [page1, [makeComment(6, 'x')]] },
    });
    await findBotMarkerComment({ ...base, octokit });
    expect(calls.listComments).toHaveLength(1); // did not fetch page 2
  });

  test('defaults marker to the MARKER constant', async () => {
    const existing = makeComment(5, `review\n\n${MARKER}`, BOT_USER);
    const { octokit } = makeOctokit({ list: [existing] });
    const found = await findBotMarkerComment({ ...base, octokit });
    expect(found?.id).toBe(5);
  });
});

describe('findBotMarkerComments', () => {
  // W16-B2-3: findBotMarkerComment returns only the FIRST bot marker comment
  // in API order. When a fallback comment exists (created after an
  // inline-review failure — the fallback path always CREATES a new comment),
  // its hash block (the newest full set) was never read — orphaned
  // suppression data. Consumers need the FULL list (same pagination +
  // bot-authority gating) so they can union hash blocks across ALL marker
  // comments.
  const base = { owner: 'o', repo: 'r', issueNumber: 42 };

  test('returns ALL bot marker comments in API order', async () => {
    const first = makeComment(11, `one\n\n${MARKER}\n<!-- zai-hashes:aaa -->`, BOT_USER);
    const second = makeComment(22, `two\n\n${MARKER}\n<!-- zai-hashes:bbb -->`, BOT_USER);
    const { octokit } = makeOctokit({
      list: [makeComment(1, 'noise'), first, second],
    });

    const all = await findBotMarkerComments({ ...base, octokit });

    expect(all.map((c) => c.id)).toEqual([11, 22]);
    expect(all.every((c) => typeof c.body === 'string')).toBe(true);
  });

  test('excludes human (User) marker comments — bot-authority gate', async () => {
    const spoofed = makeComment(9, `attacker\n\n${MARKER}\n<!-- zai-hashes:FORGED -->`, HUMAN_USER);
    const real = makeComment(10, `real\n\n${MARKER}`, BOT_USER);
    const { octokit } = makeOctokit({ list: [spoofed, real] });

    const all = await findBotMarkerComments({ ...base, octokit });

    expect(all.map((c) => c.id)).toEqual([10]);
  });

  test('matches bot comments via the [bot] login suffix (type absent)', async () => {
    const existing = makeComment(12, `review\n\n${MARKER}`, { login: 'z-ai-reviewer[bot]' });
    const { octokit } = makeOctokit({ list: [existing] });
    const all = await findBotMarkerComments({ ...base, octokit });
    expect(all.map((c) => c.id)).toEqual([12]);
  });

  test('paginates beyond 100 comments and returns markers from EVERY page', async () => {
    // Page 1 is full (100 comments) with a bot marker at position 51; page 2
    // carries another bot marker. Both must be returned.
    const page1 = Array.from({ length: 100 }, (_, i) =>
      i === 50
        ? makeComment(51, `p1 marker\n\n${MARKER}`, BOT_USER)
        : makeComment(i + 1, 'x'),
    );
    const page2 = [makeComment(101, `p2 marker\n\n${MARKER}`, BOT_USER)];
    const { octokit, calls } = makeOctokit({
      paginated: { perPage: 100, pages: [page1, page2] },
    });

    const all = await findBotMarkerComments({ ...base, octokit });

    expect(all.map((c) => c.id)).toEqual([51, 101]);
    expect(calls.listComments).toHaveLength(2);
    expect(calls.listComments[0].page).toBe(1);
    expect(calls.listComments[1].page).toBe(2);
  });

  test('returns [] when no comments exist / none carry the marker', async () => {
    const { octokit: empty } = makeOctokit({ list: [] });
    expect(await findBotMarkerComments({ ...base, octokit: empty })).toEqual([]);
    const { octokit: noMarker } = makeOctokit({
      list: [makeComment(1, 'plain'), makeComment(2, 'still no marker', BOT_USER)],
    });
    expect(await findBotMarkerComments({ ...base, octokit: noMarker })).toEqual([]);
  });

  test('defaults marker to the MARKER constant', async () => {
    const existing = makeComment(5, `review\n\n${MARKER}`, BOT_USER);
    const { octokit } = makeOctokit({ list: [existing] });
    const all = await findBotMarkerComments({ ...base, octokit });
    expect(all.map((c) => c.id)).toEqual([5]);
  });

  test('terminates after exactly 100 pages when the endpoint never returns a short page (CORE-4 cap)', async () => {
    // F-BOTGATE: the 100-page cap was previously UNTESTED. A misbehaving
    // endpoint that always returns a FULL page (never short, never carrying
    // the marker) would paginate forever without the cap. The fake throws
    // once it is called more than 105 times, so a missing/oversized cap
    // fails FAST with a propagated rejection instead of hanging the runner.
    let calls = 0;
    const fullPage = Array.from({ length: 100 }, (_, i) =>
      makeComment(i + 1, 'plain human noise', HUMAN_USER),
    );
    const octokit = {
      rest: {
        issues: {
          async listComments(params) {
            calls += 1;
            if (calls > 105) {
              throw new Error(`cap test: fetched page ${params.page} (call #${calls}) past the 100-page cap`);
            }
            return { data: fullPage };
          },
        },
      },
    };

    const all = await findBotMarkerComments({ ...base, octokit });

    expect(calls).toBe(100); // exactly 100 pages, then the cap stops the loop
    expect(all).toEqual([]); // none of the human noise ever matched
  });

  test('listComments rejection propagates (not swallowed)', async () => {
    const boom = new Error('api down');
    const { octokit } = makeOctokit({ throwOnList: boom });
    await expect(findBotMarkerComments({ ...base, octokit })).rejects.toBe(boom);
  });

  test('findBotMarkerComment stays a first-match wrapper over the plural finder', async () => {
    const first = makeComment(11, `one\n\n${MARKER}`, BOT_USER);
    const second = makeComment(22, `two\n\n${MARKER}`, BOT_USER);
    const { octokit } = makeOctokit({ list: [first, second] });

    const found = await findBotMarkerComment({ ...base, octokit });

    expect(found?.id).toBe(11); // FIRST in API order, not the newest
  });
});

describe('collectPages', () => {
  // F-BOTGATE: the single shared pagination loop (CORE-4) that now backs
  // findBotMarkerComments (comments.js) and listBotReviews (review.js).
  // Contract: per_page-sized batches, 1-based page numbers passed to
  // fetchPage, stop on a short/empty/non-array page, hard cap at maxPages,
  // and fetchPage rejections propagate (never swallowed).

  test('stops after exactly maxPages (default 100) when every page is full (CORE-4 cap)', async () => {
    let calls = 0;
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }));
    const items = await collectPages(async () => {
      calls += 1;
      if (calls > 105) throw new Error('cap test: fetched past the 100-page cap');
      return fullPage;
    });

    expect(calls).toBe(100); // exactly 100 fetches, then the cap stops the loop
    expect(items).toHaveLength(100 * 100);
  });

  test('passes 1-based page numbers and stops on the first short page', async () => {
    const seenPages = [];
    const items = await collectPages(async (page) => {
      seenPages.push(page);
      return page === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }];
    }, { perPage: 2 });

    expect(seenPages).toEqual([1, 2]);
    expect(items.map((i) => i.id)).toEqual([1, 2, 3]);
  });

  test('stops on an empty page', async () => {
    let calls = 0;
    const items = await collectPages(
      async () => {
        calls += 1;
        return calls === 1 ? [{ id: 1 }] : [];
      },
      { perPage: 1 }, // page 1 is FULL → the loop must try page 2 (empty → stop)
    );
    expect(calls).toBe(2);
    expect(items).toEqual([{ id: 1 }]);
  });

  test('stops on a non-array page (defensive: treated as end of data)', async () => {
    let calls = 0;
    const items = await collectPages(
      async () => {
        calls += 1;
        return calls === 1 ? [{ id: 1 }] : null;
      },
      { perPage: 1 }, // page 1 is FULL → the loop must try page 2 (non-array → stop)
    );
    expect(calls).toBe(2);
    expect(items).toEqual([{ id: 1 }]);
  });

  test('fetchPage rejection propagates (not swallowed)', async () => {
    const boom = new Error('api down');
    await expect(
      collectPages(async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });
});

describe('isBotAuthor', () => {
  // F-BOTGATE: the single bot-authority predicate (previously duplicated as
  // isBotComment in comments.js, isBotReview in review.js, and isBotComment
  // in schedule.js). Accepts EITHER signal GitHub surfaces for bot accounts:
  // user.type === 'Bot' OR user.login ending in [bot]. Missing/absent user
  // cannot prove authorship and is treated as non-bot (W15-A3-6 gate).
  test.each([
    ['GitHub App bot account (type Bot)', { type: 'Bot', login: 'z-ai-reviewer' }, true],
    ['bot login suffix (type absent)', { login: 'github-actions[bot]' }, true],
    ['both signals', { type: 'Bot', login: 'x[bot]' }, true],
    ['human (type User)', { type: 'User', login: 'alice' }, false],
    ['human whose login merely CONTAINS [bot]', { type: 'User', login: 'alice[bot]sworth' }, false],
    ['empty user object', {}, false],
  ])('%s → %s', (label, user, expected) => {
    expect(isBotAuthor({ user })).toBe(expected);
  });

  test('missing user / nullish item → false (cannot prove authorship)', () => {
    expect(isBotAuthor({})).toBe(false);
    expect(isBotAuthor(null)).toBe(false);
    expect(isBotAuthor(undefined)).toBe(false);
  });
});
