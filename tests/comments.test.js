/**
 * Tests for src/lib/comments.js — idempotent marker-based comment upsert.
 *
 * Octokit and `core` are injected (parameters), never imported. Stubs capture
 * calls so we verify real behavior of the upsert branching logic.
 */
import { upsertReviewComment, buildCommentBody, MARKER } from '../src/lib/comments.js';

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
