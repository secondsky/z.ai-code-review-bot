/**
 * Shared fixtures and fakes for the integration tests.
 *
 * These integration tests drive `run(context, deps)` from `src/index.js` with
 * the REAL handler registry wired in (`deps.handlers = HANDLERS`) and every
 * external collaborator faked: no network, no real GitHub. The fakes here are
 * deliberately DETERMINISTIC and RECORD every call so tests can assert on the
 * meaningful end-to-end outcomes (callApi called/not, comment posted/not,
 * reaction created/not, run resolved/rejected).
 *
 * Shape notes:
 *  - `makeConfig` mirrors the object `loadConfig` produces (see src/lib/config.js).
 *  - `makeFakeOctokit` exposes every `rest.*` method the router + handlers +
 *    `upsertReviewComment` + `getChangedFiles` + `getPRContext` touch.
 *  - `makeFakeCallApi` captures `(apiKey, model, prompt)` and returns canned text.
 *  - `makePRContext` / `makeCommentContext` build realistic @actions/github
 *    context shapes (eventName + payload + repo).
 */
import { vi } from 'vitest';
import { MARKER } from '../../src/lib/comments.js';

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

/**
 * Build a valid config object matching `loadConfig`'s shape.
 *
 * Defaults match the brief's integration-test baseline:
 *   commandsEnabled: true, authThreshold: 'write', allowForkCommands: false.
 *
 * @param {Partial<ReturnType<typeof import('../../src/lib/config.js').loadConfig>>} [overrides]
 */
export function makeConfig(overrides = {}) {
  return {
    apiKey: 'test-api-key',
    model: 'glm-5.2',
    systemPrompt: '',
    reviewerName: 'Z.ai Code Review',
    excludePatterns: ['*.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'],
    maxDiffChars: 0,
    largePrFileThreshold: 50,
    maxBatchChars: 120000,
    maxFilesPerBatch: 40,
    maxPatchChars: 18000,
    commandsEnabled: true,
    authThreshold: 'write',
    allowForkCommands: false,
    timeoutMs: 120000,
    scheduleEnabled: false,
    scheduleMaxPrs: 10,
    describeWriteBody: false,
    impactLabels: false,
    impactLabelMap: { critical: 'zai:critical', high: 'zai:high', medium: 'zai:medium', low: 'zai:low' },
    githubToken: 'ghs-test-token',
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * Fake core (@actions/core)
 * ------------------------------------------------------------------ */

/**
 * A fake `@actions/core` capturing every call. All methods are no-ops that
 * record their arguments.
 */
export function makeFakeCore() {
  return {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    setFailed: vi.fn(),
    setSecret: vi.fn(),
    getInput: vi.fn(() => ''),
  };
}

/* ------------------------------------------------------------------ *
 * Fake octokit
 * ------------------------------------------------------------------ */

/**
 * A patchable file fixture (the shape `getChangedFiles` returns).
 * @param {string} filename
 * @param {string} [patch]
 * @param {string} [status]
 */
export function file(filename, patch = '@@ diff @@', status = 'modified') {
  return { filename, status, patch };
}

/**
 * Build a fake octokit whose `rest.*` methods return canned data and record
 * every call. Captured calls live on `octokit.__calls`.
 *
 * Methods faked (the union of what the router, handlers, upsertReviewComment,
 * getChangedFiles, and getPRContext touch):
 *   - rest.pulls.listFiles / get / listCommits
 *   - rest.issues.listComments / createComment / updateComment
 *   - rest.repos.getContent
 *
 * @param {{
 *   files?: Array,
 *   existingComments?: Array<{id: number, body: string}>,
 *   pr?: object,
 *   commits?: Array,
 *   content?: object,
 * }} [options]
 */
export function makeFakeOctokit({
  files = [],
  existingComments = [],
  pr = { title: 'Test PR', body: 'A test PR body.' },
  commits = [],
  content = { content: '', encoding: 'utf-8' },
} = {}) {
  const calls = {
    listFiles: [],
    get: [],
    listCommits: [],
    listComments: [],
    createComment: [],
    updateComment: [],
    getContent: [],
  };

  const octokit = {
    rest: {
      pulls: {
        async listFiles(params) {
          calls.listFiles.push(params);
          return { data: files };
        },
        async get(params) {
          calls.get.push(params);
          return { data: pr };
        },
        async listCommits(params) {
          calls.listCommits.push(params);
          return { data: commits };
        },
      },
      issues: {
        async listComments(params) {
          calls.listComments.push(params);
          return { data: existingComments };
        },
        async createComment(params) {
          calls.createComment.push(params);
          return { data: { id: 1, ...params } };
        },
        async updateComment(params) {
          calls.updateComment.push(params);
          return { data: { id: params.comment_id, ...params } };
        },
      },
      repos: {
        async getContent(params) {
          calls.getContent.push(params);
          return { data: content };
        },
      },
    },
  };

  // Attach the call log so tests can assert on it.
  Object.defineProperty(octokit, '__calls', {
    value: calls,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return octokit;
}

/* ------------------------------------------------------------------ *
 * Fake callApi
 * ------------------------------------------------------------------ */

/**
 * Build a fake `callApi(apiKey, model, prompt)` that records every invocation
 * and returns the canned `response`. Pass a function as `response` to vary the
 * return per-call (e.g. for multi-batch runs). To test the failure path, pass
 * `rejectWith` (an Error or a string); the fake throws on every call.
 *
 * @param {string | ((apiKey: string, model: string, prompt: string) => string)} [response]
 * @param {{ rejectWith?: Error | string }} [options]
 */
export function makeFakeCallApi(
  response = 'canned review',
  { rejectWith } = {},
) {
  const fn = vi.fn(async (apiKey, model, prompt) => {
    if (rejectWith) {
      throw rejectWith instanceof Error ? rejectWith : new Error(String(rejectWith));
    }
    return typeof response === 'function' ? response(apiKey, model, prompt) : response;
  });
  return fn;
}

/* ------------------------------------------------------------------ *
 * Context builders
 * ------------------------------------------------------------------ */

/**
 * Build a realistic `pull_request` context.
 *
 * @param {{
 *   number?: number,
 *   fork?: boolean,
 *   title?: string,
 *   body?: string,
 *   action?: string,
 *   owner?: string,
 *   repo?: string,
 * }} [overrides]
 */
export function makePRContext({
  number = 42,
  fork = false,
  title = 'Test PR',
  body = 'A test PR body.',
  action = 'opened',
  owner = 'owner',
  repo = 'repo',
} = {}) {
  return {
    eventName: 'pull_request',
    payload: {
      action,
      number,
      pull_request: {
        number,
        title,
        body,
        head: { repo: { fork }, ref: 'feature' },
        base: { ref: 'main' },
      },
    },
    repo: { owner, repo },
  };
}

/**
 * Build a realistic `issue_comment` context on a PR (by default).
 *
 * `author_association` is set on BOTH `comment.user` and `comment` (GitHub
 * populates both) and on `sender`, matching real webhook payloads.
 *
 * @param {{
 *   number?: number,
 *   body?: string,
 *   association?: string,
 *   login?: string,
 *   isPr?: boolean,
 *   owner?: string,
 *   repo?: string,
 * }} [overrides]
 */
export function makeCommentContext({
  number = 42,
  body = '/zai ask what is this',
  association = 'COLLABORATOR',
  login = 'alice',
  isPr = true,
  owner = 'owner',
  repo = 'repo',
} = {}) {
  return {
    eventName: 'issue_comment',
    payload: {
      action: 'created',
      comment: {
        id: 100,
        body,
        user: { login, author_association: association, type: 'User' },
        author_association: association,
      },
      sender: { login, author_association: association, type: 'User' },
      issue: isPr
        ? { number, title: 'Test PR', body: 'A test PR body.', pull_request: {} }
        : { number, title: 'Test issue', body: 'A test issue.' },
    },
    repo: { owner, repo },
  };
}

/* ------------------------------------------------------------------ *
 * Convenience: the review marker (re-exported for assertions)
 * ------------------------------------------------------------------ */

export { MARKER };
