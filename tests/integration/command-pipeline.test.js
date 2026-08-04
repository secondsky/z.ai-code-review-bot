/**
 * Integration tests: issue_comment → parse → authorize → dispatch pipeline.
 *
 * THE KEY DIFFERENCE FROM tests/index.test.js: these tests wire the REAL
 * `HANDLERS` registry (`deps.handlers = HANDLERS`) from src/lib/handlers/index.js.
 * The unit-level index tests inject a single fake handler to prove the router
 * plumbing; these tests prove that nothing in the REAL handler registry can
 * sneak around the auth gate, and that an authorized command end-to-end
 * produces a posted comment via the real handler + injected callApi.
 *
 * The single most important assertion in this file (and in task 9) is the
 * "unauthorized user blocked end-to-end" test: a `/zai ask` from a commenter
 * with author_association NONE produces NO callApi call, NO handler dispatch,
 * NO comment, and NO reaction — the full parse → authorize → dispatch stack
 * blocks silently. This is the full-stack proof with REAL HANDLERS wired in.
 *
 * Matrix (per task-9-brief):
 *   - [KEY] unauthorized (NONE) blocked end-to-end with REAL HANDLERS
 *   - authorized (COLLABORATOR) /zai ask → real ask handler fires, comment posted
 *   - authorized /zai help → real help handler, NO callApi, help table posted
 *   - authorized /zai review <file> → real review handler, callApi called, comment posted
 *   - authorized unknown /zai frobnicate → graceful no-op
 *   - bot comment (github-actions[bot]) → anti-loop, no dispatch
 *   - commands disabled → no dispatch
 *   - non-PR issue comment → early return, no dispatch
 *   - @zai alias → parses to help, comment posted
 *   - fork gate (see note): documented limitation — tested at the auth unit level
 */
import { describe, it, expect } from 'vitest';

import { run } from '../../src/index.js';
import { HANDLERS } from '../../src/lib/handlers/index.js';
import { authorize } from '../../src/lib/auth.js';
import {
  makeConfig,
  makeFakeCore,
  makeFakeOctokit,
  makeFakeCallApi,
  makeCommentContext,
  file,
} from './helpers.js';

/* ------------------------------------------------------------------ *
 * Shared scenario runner for the command pipeline.
 *
 * Every command-pipeline test wires `deps.handlers = HANDLERS` (the REAL
 * registry). callApi is faked so no network is touched. The fake octokit
 * serves canned PR + file data so the real handlers (ask/review/help) can run
 * their full internal flow.
 * ------------------------------------------------------------------ */

/**
 * Build a fully-wired deps object for the command pipeline.
 * @param {{ config?: object, octokit?: object, core?: object, callApi?: Function }} [parts]
 */
function wiredDeps({
  config = makeConfig(),
  octokit = makeFakeOctokit({ files: [file('src/a.js', '@@ -1 +1 @@\n+const a = 1;')] }),
  core = makeFakeCore(),
  callApi = makeFakeCallApi('canned answer'),
} = {}) {
  return {
    config,
    core,
    octokit,
    callApi,
    // The REAL handler registry — this is the whole point of the integration test.
    handlers: HANDLERS,
    // Stub apiClient so buildCallApi never creates a real client.
    apiClient: { call: () => Promise.resolve({ success: true, data: '' }) },
  };
}

/* ------------------------------------------------------------------ *
 * THE CENTERPIECE: unauthorized user blocked end-to-end
 * ------------------------------------------------------------------ */

describe('integration: issue_comment pipeline — [KEY] unauthorized user blocked end-to-end', () => {
  it('a NONE commenter issuing /zai ask triggers NO callApi, NO dispatch, NO comment, NO reaction', async () => {
    // This is the single most important assertion in task 9. It runs the REAL
    // router with the REAL HANDLERS registry wired in. An unauthorized
    // commenter must be blocked across the full parse → authorize → dispatch
    // stack — nothing in the real handler registry can sneak around the gate.
    const core = makeFakeCore();
    const octokit = makeFakeOctokit();
    const callApi = makeFakeCallApi('must not be called');
    const ctx = makeCommentContext({
      body: '/zai ask what is this',
      association: 'NONE',
      login: 'rando',
    });

    await run(ctx, wiredDeps({ core, octokit, callApi }));

    // No Z.ai call.
    expect(callApi).not.toHaveBeenCalled();
    // No handler dispatch side-effect: no command-response comment posted.
    expect(octokit.__calls.createComment).toHaveLength(0);
    expect(octokit.__calls.updateComment).toHaveLength(0);
    // No listing of comments either (the block happens before any handler work).
    expect(octokit.__calls.listComments).toHaveLength(0);
    expect(octokit.__calls.listFiles).toHaveLength(0);
    // run resolved (did not throw) — the block is silent.
    expect(core.setFailed).not.toHaveBeenCalled();
    // The silent-block info log fired.
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('Blocked command from unauthorized user'),
    );
  });

  it('a NONE commenter issuing /zai review <file> is also blocked', async () => {
    // The auth gate is command-agnostic; verify a different command is blocked too.
    const core = makeFakeCore();
    const octokit = makeFakeOctokit();
    const callApi = makeFakeCallApi('must not be called');
    const ctx = makeCommentContext({
      body: '/zai review src/a.js',
      association: 'NONE',
      login: 'rando',
    });

    await run(ctx, wiredDeps({ core, octokit, callApi }));

    expect(callApi).not.toHaveBeenCalled();
    expect(octokit.__calls.createComment).toHaveLength(0);
    expect(octokit.__calls.listFiles).toHaveLength(0);
  });

  it('an unauthorized FIRST_TIME_CONTRIBUTOR is blocked (write threshold)', async () => {
    // CONTRIBUTOR is NOT in the write-threshold allowed set
    // (OWNER, MEMBER, COLLABORATOR). A first-time contributor (NONE) is blocked.
    const core = makeFakeCore();
    const octokit = makeFakeOctokit();
    const callApi = makeFakeCallApi('must not be called');
    const ctx = makeCommentContext({
      body: '/zai help',
      association: 'FIRST_TIME_CONTRIBUTOR',
      login: 'newbie',
    });

    await run(ctx, wiredDeps({ core, octokit, callApi }));

    expect(callApi).not.toHaveBeenCalled();
    expect(octokit.__calls.createComment).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Authorized /zai ask
 * ------------------------------------------------------------------ */

describe('integration: issue_comment pipeline — authorized /zai ask', () => {
  it('a COLLABORATOR issuing /zai ask gets a real answer comment via the real ask handler', async () => {
    const core = makeFakeCore();
    const octokit = makeFakeOctokit({
      files: [file('src/a.js', '@@ -1 +1 @@\n+const a = 1;')],
      pr: { title: 'Add a', body: 'adds const a' },
    });
    const callApi = makeFakeCallApi('the answer is 42');
    const ctx = makeCommentContext({
      body: '/zai ask what does this PR do',
      association: 'COLLABORATOR',
      login: 'alice',
    });

    await run(ctx, wiredDeps({ core, octokit, callApi }));

    // The real ask handler called callApi once (it built a prompt from the PR
    // context + diff and posted the answer).
    expect(callApi).toHaveBeenCalledTimes(1);
    const [, , prompt] = callApi.mock.calls[0];
    expect(prompt).toContain('what does this PR do');
    // The prompt was built from the real PR context (title) and changed files.
    expect(prompt).toContain('Add a');
    expect(prompt).toContain('src/a.js');

    // A command-response comment was posted with the answer.
    expect(octokit.__calls.createComment).toHaveLength(1);
    expect(octokit.__calls.createComment[0].body).toBe('the answer is 42');
  });

  it('a MEMBER issuing /zai ask with no question gets the empty-args guidance comment', async () => {
    const core = makeFakeCore();
    const octokit = makeFakeOctokit();
    const callApi = makeFakeCallApi('must not be called');
    const ctx = makeCommentContext({
      body: '/zai ask',
      association: 'MEMBER',
      login: 'bob',
    });

    await run(ctx, wiredDeps({ core, octokit, callApi }));

    // No Z.ai call (the real ask handler short-circuits on empty args).
    expect(callApi).not.toHaveBeenCalled();
    // The guidance comment was posted.
    expect(octokit.__calls.createComment).toHaveLength(1);
    expect(octokit.__calls.createComment[0].body).toMatch(/provide a question/i);
  });
});

/* ------------------------------------------------------------------ *
 * Authorized /zai help (static, no callApi)
 * ------------------------------------------------------------------ */

describe('integration: issue_comment pipeline — authorized /zai help', () => {
  it('a COLLABORATOR issuing /zai help gets the help table with NO callApi', async () => {
    const core = makeFakeCore();
    const octokit = makeFakeOctokit();
    const callApi = makeFakeCallApi('must not be called');
    const ctx = makeCommentContext({
      body: '/zai help',
      association: 'COLLABORATOR',
      login: 'alice',
    });

    await run(ctx, wiredDeps({ core, octokit, callApi }));

    // help is static — no Z.ai call.
    expect(callApi).not.toHaveBeenCalled();
    // The help table comment was posted.
    expect(octokit.__calls.createComment).toHaveLength(1);
    const body = octokit.__calls.createComment[0].body;
    expect(body).toContain('Z.ai Commands');
    expect(body).toContain('`/zai ask`');
    expect(body).toContain('`/zai review`');
    expect(body).toContain('`/zai help`');
  });
});

/* ------------------------------------------------------------------ *
 * Authorized /zai review <file>
 * ------------------------------------------------------------------ */

describe('integration: issue_comment pipeline — authorized /zai review <file>', () => {
  it('a COLLABORATOR issuing /zai review src/a.js gets a focused review comment', async () => {
    const core = makeFakeCore();
    const octokit = makeFakeOctokit({
      files: [file('src/a.js', '@@ -1 +1 @@\n+const a = 1;')],
    });
    const callApi = makeFakeCallApi('lgtm');
    const ctx = makeCommentContext({
      body: '/zai review src/a.js',
      association: 'COLLABORATOR',
      login: 'alice',
    });

    await run(ctx, wiredDeps({ core, octokit, callApi }));

    // The real review handler called callApi once with a file-focused prompt.
    expect(callApi).toHaveBeenCalledTimes(1);
    const prompt = callApi.mock.calls[0][2];
    expect(prompt).toContain('src/a.js');
    expect(prompt).toContain('const a = 1;');
    // The review was posted as a comment.
    expect(octokit.__calls.createComment).toHaveLength(1);
    expect(octokit.__calls.createComment[0].body).toBe('lgtm');
  });

  it('a COLLABORATOR issuing /zai review <missing-file> gets a not-part-of-PR comment, NO callApi', async () => {
    const core = makeFakeCore();
    const octokit = makeFakeOctokit({
      files: [file('src/a.js', '@@ diff @@')],
    });
    const callApi = makeFakeCallApi('must not be called');
    const ctx = makeCommentContext({
      body: '/zai review src/missing.js',
      association: 'COLLABORATOR',
      login: 'alice',
    });

    await run(ctx, wiredDeps({ core, octokit, callApi }));

    // File not in the PR → no Z.ai call.
    expect(callApi).not.toHaveBeenCalled();
    expect(octokit.__calls.createComment).toHaveLength(1);
    expect(octokit.__calls.createComment[0].body).toMatch(/not part of this PR/i);
  });
});

/* ------------------------------------------------------------------ *
 * Unknown command (graceful)
 * ------------------------------------------------------------------ */

describe('integration: issue_comment pipeline — unknown command', () => {
  it('an authorized /zai frobnicate is a graceful no-op: no dispatch, no callApi, no comment', async () => {
    const core = makeFakeCore();
    const octokit = makeFakeOctokit();
    const callApi = makeFakeCallApi('must not be called');
    const ctx = makeCommentContext({
      body: '/zai frobnicate',
      association: 'COLLABORATOR',
      login: 'alice',
    });

    await run(ctx, wiredDeps({ core, octokit, callApi }));

    // Unknown command → parsed.error = 'UNKNOWN_COMMAND' → router logs + returns.
    expect(callApi).not.toHaveBeenCalled();
    expect(octokit.__calls.createComment).toHaveLength(0);
    expect(core.info).toHaveBeenCalledWith(
      expect.stringMatching(/unrecognized command/i),
    );
    expect(core.setFailed).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * Bot comment (anti-loop)
 * ------------------------------------------------------------------ */

describe('integration: issue_comment pipeline — bot comment anti-loop', () => {
  it('a github-actions[bot] comment is ignored: no dispatch, no callApi, no comment', async () => {
    // The bot check fires BEFORE auth — even though bots carry NONE association,
    // they're blocked by the anti-loop guard, not the auth gate. Either way: no
    // dispatch.
    const core = makeFakeCore();
    const octokit = makeFakeOctokit();
    const callApi = makeFakeCallApi('must not be called');
    const ctx = makeCommentContext({
      body: '/zai ask what is this',
      login: 'github-actions[bot]',
      association: 'NONE',
    });

    await run(ctx, wiredDeps({ core, octokit, callApi }));

    expect(callApi).not.toHaveBeenCalled();
    expect(octokit.__calls.createComment).toHaveLength(0);
    expect(octokit.__calls.listFiles).toHaveLength(0);
    // No setFailed — anti-loop is a silent return.
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('a dependabot[bot] comment is also ignored', async () => {
    const core = makeFakeCore();
    const octokit = makeFakeOctokit();
    const callApi = makeFakeCallApi('must not be called');
    const ctx = makeCommentContext({
      body: '/zai help',
      login: 'dependabot[bot]',
      association: 'NONE',
    });

    await run(ctx, wiredDeps({ core, octokit, callApi }));

    expect(callApi).not.toHaveBeenCalled();
    expect(octokit.__calls.createComment).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Commands disabled
 * ------------------------------------------------------------------ */

describe('integration: issue_comment pipeline — commands disabled', () => {
  it('a COLLABORATOR comment when commandsEnabled is false: no dispatch, no callApi', async () => {
    const core = makeFakeCore();
    const octokit = makeFakeOctokit();
    const callApi = makeFakeCallApi('must not be called');
    const ctx = makeCommentContext({
      body: '/zai ask hi',
      association: 'COLLABORATOR',
      login: 'alice',
    });

    await run(ctx, wiredDeps({ core, octokit, callApi, config: makeConfig({ commandsEnabled: false }) }));

    expect(callApi).not.toHaveBeenCalled();
    expect(octokit.__calls.createComment).toHaveLength(0);
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('Commands disabled'),
    );
  });
});

/* ------------------------------------------------------------------ *
 * Non-PR issue comment (early return)
 * ------------------------------------------------------------------ */

describe('integration: issue_comment pipeline — non-PR issue comment', () => {
  it('a /zai ask on a plain issue (no issue.pull_request) returns early: no dispatch', async () => {
    const core = makeFakeCore();
    const octokit = makeFakeOctokit();
    const callApi = makeFakeCallApi('must not be called');
    const ctx = makeCommentContext({
      body: '/zai ask hi',
      association: 'COLLABORATOR',
      login: 'alice',
      isPr: false,
    });

    await run(ctx, wiredDeps({ core, octokit, callApi }));

    // The router returns early because getPullNumber is null for non-PR issues.
    expect(callApi).not.toHaveBeenCalled();
    expect(octokit.__calls.createComment).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * @zai alias
 * ------------------------------------------------------------------ */

describe('integration: issue_comment pipeline — @zai alias', () => {
  it('@zai help from a COLLABORATOR parses to help and posts the help table', async () => {
    const core = makeFakeCore();
    const octokit = makeFakeOctokit();
    const callApi = makeFakeCallApi('must not be called');
    const ctx = makeCommentContext({
      body: '@zai help',
      association: 'COLLABORATOR',
      login: 'alice',
    });

    await run(ctx, wiredDeps({ core, octokit, callApi }));

    // The @zai alias was parsed and the real help handler dispatched.
    expect(callApi).not.toHaveBeenCalled();
    expect(octokit.__calls.createComment).toHaveLength(1);
    expect(octokit.__calls.createComment[0].body).toContain('Z.ai Commands');
  });

  it('@zai-bot ask from a MEMBER parses and routes to the real ask handler', async () => {
    const core = makeFakeCore();
    const octokit = makeFakeOctokit({
      files: [file('src/a.js', '@@ diff @@')],
    });
    const callApi = makeFakeCallApi('alias answer');
    const ctx = makeCommentContext({
      body: '@zai-bot ask why',
      association: 'MEMBER',
      login: 'bob',
    });

    await run(ctx, wiredDeps({ core, octokit, callApi }));

    expect(callApi).toHaveBeenCalledTimes(1);
    expect(callApi.mock.calls[0][2]).toContain('why');
    expect(octokit.__calls.createComment[0].body).toBe('alias answer');
  });
});

/* ------------------------------------------------------------------ *
 * Fork gate (documented limitation)
 * ------------------------------------------------------------------ */

describe('integration: issue_comment pipeline — fork gate (documented limitation)', () => {
  // NOTE ON THE FORK GATE (accepted v1 boundary):
  //
  // The fork gate in src/lib/auth.js blocks when `isFork === true` AND
  // `allowForkCommands !== true`. However, `isForkPullRequest(context)` in
  // src/lib/events.js returns `false` for issue_comment events BY DESIGN —
  // the comment payload alone does not carry enough information to determine
  // fork-ness (it would require a separate PR fetch, which the v1 router does
  // not perform). The router therefore passes `isFork = false` to `authorize`
  // for every issue_comment event.
  //
  // This means the fork gate CANNOT be exercised end-to-end through `run()`
  // at this layer — the workflow-level `if:` gate (documented in the example
  // workflows) is the PRIMARY fork protection for issue_comment events, and
  // that is an accepted v1 boundary per the task brief.
  //
  // Below we prove the fork gate itself works at the auth unit level (so the
  // gate is known-good; it simply isn't reachable from run() for comments),
  // and we confirm run() does not crash on a PR-comment context whose
  // underlying PR happens to be a fork (the router just can't see it).

  it('authorize() blocks a fork comment when allowForkCommands is false (gate proven at unit level)', () => {
    // Direct proof that the gate works — it just isn't reachable from run()
    // for issue_comment events because isForkPullRequest() returns false there.
    const result = authorize({
      comment: { author_association: 'COLLABORATOR' },
      sender: { author_association: 'COLLABORATOR' },
      isFork: true,
      config: { authThreshold: 'write', allowForkCommands: false },
    });
    expect(result.authorized).toBe(false);
    expect(result.silent).toBe(true);
    expect(result.reason).toBe('fork_not_allowed');
  });

  it('authorize() allows a fork comment when allowForkCommands is true', () => {
    const result = authorize({
      comment: { author_association: 'COLLABORATOR' },
      sender: { author_association: 'COLLABORATOR' },
      isFork: true,
      config: { authThreshold: 'write', allowForkCommands: true },
    });
    expect(result.authorized).toBe(true);
  });

  it('run() cannot see fork-ness from an issue_comment context — a COLLABORATOR on a fork-PR comment still dispatches (documented v1 boundary)', async () => {
    // The underlying PR is a fork (head.repo.fork would be true), but the
    // issue_comment payload doesn't expose that, so run()'s isForkPullRequest
    // returns false and the fork gate does not fire. The workflow `if:` gate
    // is the real fork protection. This test documents the boundary: the
    // command dispatches because run() can't see fork-ness.
    const core = makeFakeCore();
    const octokit = makeFakeOctokit({
      files: [file('src/a.js', '@@ diff @@')],
    });
    const callApi = makeFakeCallApi('fork answer');
    const ctx = makeCommentContext({
      body: '/zai ask hi',
      association: 'COLLABORATOR',
      login: 'alice',
    });

    await run(ctx, wiredDeps({ core, octokit, callApi }));

    // Documented boundary: run() dispatched the command (the in-code fork gate
    // is not reachable from issue_comment context). The workflow `if:` gate is
    // the primary fork control.
    expect(callApi).toHaveBeenCalledTimes(1);
    expect(octokit.__calls.createComment).toHaveLength(1);
  });
});
