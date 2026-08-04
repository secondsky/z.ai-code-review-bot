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
 * Authorized /zai explain <range> [file]  (regression: head SHA from API)
 * ------------------------------------------------------------------ */

describe('integration: issue_comment pipeline — authorized /zai explain <range> [file]', () => {
  // REGRESSION GUARD (Finding 1): the real `issue_comment` payload has NO
  // top-level `pull_request`, only the minimal `payload.issue.pull_request`
  // reference (no `head.sha`). Previously the handler read the head SHA from
  // `payload.pull_request.head.sha`, which is always undefined for an
  // issue_comment event, so /zai explain silently fell through to a usage
  // comment and NEVER reached callApi. This test drives the full pipeline with
  // REAL HANDLERS and a realistic payload shape (makeCommentContext produces
  // NO top-level pull_request) to prove the handler now fetches the head SHA
  // via the API (pulls.get through getPRContext) and reaches callApi.

  it('a COLLABORATOR issuing /zai explain 1-5 on a PR gets an explanation (head SHA fetched via the API, not the payload)', async () => {
    const core = makeFakeCore();
    // PR fixture carries the head SHA that getPRContext → pulls.get returns.
    // The content fixture is base64 (what repos.getContent returns).
    const fileContent = Buffer.from('l1\nl2\nl3\nl4\nl5\n').toString('base64');
    const octokit = makeFakeOctokit({
      files: [file('src/a.js', '@@ -1 +1 @@\n+const a = 1;')],
      pr: { title: 'Add a', body: 'adds const a', head: { ref: 'feat', sha: 'sha-head-abc' }, base: { ref: 'main' } },
      content: { content: fileContent, encoding: 'base64' },
    });
    const callApi = makeFakeCallApi('line-by-line explanation');
    // makeCommentContext produces the REAL issue_comment shape: NO top-level
    // pull_request, only payload.issue.pull_request: {} (a minimal reference
    // with no head.sha). This is the shape that exposed the bug.
    const ctx = makeCommentContext({
      body: '/zai explain 1-5 src/a.js',
      association: 'COLLABORATOR',
      login: 'alice',
    });

    await run(ctx, wiredDeps({ core, octokit, callApi }));

    // The real explain handler reached callApi (it did NOT fall through to the
    // usage comment — that was the bug).
    expect(callApi).toHaveBeenCalledTimes(1);
    const prompt = callApi.mock.calls[0][2];
    expect(prompt).toContain('src/a.js');
    expect(prompt).toContain('1-5');
    // The explanation was posted as a command-response comment.
    expect(octokit.__calls.createComment).toHaveLength(1);
    expect(octokit.__calls.createComment[0].body).toBe('line-by-line explanation');
    // The head SHA was fetched via the API (pulls.get), and the file snapshot
    // was fetched at that SHA via repos.getContent. Note: pulls.get is called
    // at least once for the router's fork-check and once by the explain
    // handler's getPRContext — both are expected.
    expect(octokit.__calls.get.length).toBeGreaterThanOrEqual(1);
    expect(octokit.__calls.get[0]).toMatchObject({ owner: 'owner', repo: 'repo', pull_number: 42 });
    expect(octokit.__calls.getContent).toHaveLength(1);
    expect(octokit.__calls.getContent[0]).toMatchObject({
      owner: 'owner',
      repo: 'repo',
      path: 'src/a.js',
      ref: 'sha-head-abc',
    });
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
 * Fork gate (resolved via API on the command path)
 * ------------------------------------------------------------------ */

describe('integration: issue_comment pipeline — fork gate (resolved via API)', () => {
  // The fork gate in src/lib/auth.js blocks when `isFork === true` AND
  // `allowForkCommands !== true`. The issue_comment payload does NOT carry
  // fork-ness, so when the fork gate is active the router resolves it via
  // octokit.rest.pulls.get (getPRContext) and passes the real isFork to
  // authorize(). This makes the in-code promise — "ZAI_ALLOW_FORK_COMMANDS:false
  // blocks fork-PR commands" — actually hold, including under
  // ZAI_AUTH_THRESHOLD:none where the association gate is disabled.

  it('authorize() blocks a fork comment when allowForkCommands is false (gate proven at unit level)', () => {
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

  it('a COLLABORATOR on a FORK PR is BLOCKED when allowForkCommands is false (router resolves fork-ness via API)', async () => {
    // The PR is a fork: pulls.get returns head.repo.fork === true.
    const core = makeFakeCore();
    const octokit = makeFakeOctokit({
      files: [file('src/a.js', '@@ diff @@')],
      pr: {
        title: 'Fork PR',
        body: '',
        head: { repo: { fork: true }, ref: 'f', sha: 's' },
        base: { ref: 'main' },
      },
    });
    const callApi = makeFakeCallApi('should not be called');
    const ctx = makeCommentContext({
      body: '/zai ask hi',
      association: 'COLLABORATOR',
      login: 'alice',
    });

    await run(ctx, wiredDeps({ core, octokit, callApi }));

    // Blocked: no callApi, no comment, and pulls.get was called once for the
    // fork check.
    expect(callApi).not.toHaveBeenCalled();
    expect(octokit.__calls.createComment).toHaveLength(0);
    expect(octokit.__calls.get).toHaveLength(1);
  });

  it('GAP-CLOSING: a fork-PR commenter is blocked under authThreshold:none + allowForkCommands:false', async () => {
    // Under none, the association gate is disabled — previously a fork commenter
    // with NONE association could slip through because the fork gate couldn't
    // see fork-ness. Now the router resolves it via the API and blocks.
    const core = makeFakeCore();
    const octokit = makeFakeOctokit({
      files: [file('src/a.js', '@@ diff @@')],
      pr: {
        title: 'Fork PR',
        body: '',
        head: { repo: { fork: true }, ref: 'f', sha: 's' },
        base: { ref: 'main' },
      },
    });
    const callApi = makeFakeCallApi('should not be called');
    const ctx = makeCommentContext({
      body: '/zai ask hi',
      association: 'NONE',
      login: 'driveby',
    });

    await run(
      ctx,
      wiredDeps({
        core,
        octokit,
        callApi,
        config: makeConfig({ authThreshold: 'none', allowForkCommands: false }),
      }),
    );

    expect(callApi).not.toHaveBeenCalled();
    expect(octokit.__calls.createComment).toHaveLength(0);
  });

  it('a COLLABORATOR on a fork PR is ALLOWED when allowForkCommands is true', async () => {
    const core = makeFakeCore();
    const octokit = makeFakeOctokit({
      files: [file('src/a.js', '@@ diff @@')],
      pr: {
        title: 'Fork PR',
        body: '',
        head: { repo: { fork: true }, ref: 'f', sha: 's' },
        base: { ref: 'main' },
      },
    });
    const callApi = makeFakeCallApi('fork answer');
    const ctx = makeCommentContext({
      body: '/zai ask hi',
      association: 'COLLABORATOR',
      login: 'alice',
    });

    await run(
      ctx,
      wiredDeps({
        core,
        octokit,
        callApi,
        config: makeConfig({ allowForkCommands: true }),
      }),
    );

    expect(callApi).toHaveBeenCalledTimes(1);
    expect(octokit.__calls.createComment).toHaveLength(1);
    // No fork-check API call, but the ask handler calls getPRContext once.
    expect(octokit.__calls.get).toHaveLength(1);
  });

  it('a COLLABORATOR on a NON-fork PR is allowed (fork-check resolves false)', async () => {
    const core = makeFakeCore();
    const octokit = makeFakeOctokit({
      files: [file('src/a.js', '@@ diff @@')],
      pr: {
        title: 'Regular PR',
        body: '',
        head: { repo: { fork: false }, ref: 'f', sha: 's' },
        base: { ref: 'main' },
      },
    });
    const callApi = makeFakeCallApi('answer');
    const ctx = makeCommentContext({
      body: '/zai ask hi',
      association: 'COLLABORATOR',
      login: 'alice',
    });

    await run(ctx, wiredDeps({ core, octokit, callApi }));

    expect(callApi).toHaveBeenCalledTimes(1);
    // One fork-check call + one ask-handler getPRContext call.
    expect(octokit.__calls.get).toHaveLength(2);
  });
});
