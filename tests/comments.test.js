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
 */
function makeOctokit({ list = [], throwOnList = null } = {}) {
  const calls = { listComments: [], updateComment: [], createComment: [] };

  const octokit = {
    rest: {
      issues: {
        async listComments(params) {
          calls.listComments.push(params);
          if (throwOnList) {
            throw throwOnList;
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

function makeComment(id, body) {
  return { id, body };
}

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
    const existing = makeComment(7, `prior review\n\n${MARKER}`);
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

  test('listComments called with owner/repo/issue_number and per_page:100 (v1 mitigation for >30 comments)', async () => {
    const { octokit, calls } = makeOctokit({ list: [] });
    await upsertReviewComment({ ...base, octokit });
    expect(calls.listComments).toHaveLength(1);
    expect(calls.listComments[0]).toEqual({
      owner: 'o',
      repo: 'r',
      issue_number: 42,
      per_page: 100,
    });
  });

  test('updates only the FIRST comment matching the marker when several do', async () => {
    const first = makeComment(11, `one\n\n${MARKER}`);
    const second = makeComment(22, `two\n\n${MARKER}`);
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
    const existing = makeComment(5, `review\n\n${MARKER}`);
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
    const existing = makeComment(3, `${MARKER}`);
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
});
