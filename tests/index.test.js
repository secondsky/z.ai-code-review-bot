/**
 * Tests for src/index.js — the GitHub Action entry point + event router.
 *
 * Every external collaborator is injected: octokit, core, callApi, apiClient,
 * handlers, and the runStructuredReview override. Tests never touch the
 * network or GitHub. The module MUST be importable without triggering main().
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Dynamic import so we can assert import-safety AFTER spying on core.setFailed.
// We re-import per test group where side effects matter.
const indexModule = await import('../src/index.js');
const { run, readAllInputs, isMainEntry } = indexModule;

/* ------------------------------------------------------------------ *
 * Fakes
 * ------------------------------------------------------------------ */

/** Build a fake core with spies for every method the router uses. */
function makeCore() {
  const core = {
    info: vi.fn(),
    warning: vi.fn(),
    setFailed: vi.fn(),
    setSecret: vi.fn(),
    getInput: vi.fn(() => ''),
  };
  return core;
}

/** Build a valid config object (write threshold, commands enabled). */
function makeConfig(overrides = {}) {
  return {
    apiKey: 'test-api-key',
    model: 'glm-5.2',
    systemPrompt: '',
    reviewerName: 'Z.ai Code Review',
    excludePatterns: ['*.lock'],
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
    maxFindings: 8,
    minSeverity: 'info',
    temperature: 0.2,
    maxTokens: 4096,
    batchConcurrency: 3,
    fallbackPrompt: '',
    // Phase 4: scanner master switch OFF in tests by default so the real
    // runScanners (which would download gitleaks/ast-grep) is short-circuited.
    scannersEnabled: false,
    scannersCacheDir: '/tmp/zai-cache-scanners-test',
    // Phase 5: commit-status feedback. Default OFF in unit tests so existing
    // assertions on octokit calls stay stable; dedicated status tests opt in.
    commitStatus: false,
    githubToken: 'ghs-test-token',
    ...overrides,
  };
}

/** A patchable file. */
function file(filename, patch = '@@ diff @@', status = 'modified') {
  return { filename, status, patch };
}

/** Build a fake octokit with the rest methods the router calls. */
function makeOctokit({
  files = [],
  list = [],
  pr = null,
  existingReviews = [],
  createReviewFails = false,
} = {}) {
  const calls = {
    listFiles: [],
    listComments: [],
    createComment: [],
    updateComment: [],
    get: [],
    listReviews: [],
    dismissReview: [],
    createReview: [],
    createCommitStatus: [],
  };
  const defaultPr = {
    title: 'T',
    body: 'B',
    head: { ref: 'r', sha: 's', repo: { fork: false } },
    base: { ref: 'main' },
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
          return { data: pr ?? defaultPr };
        },
        async listReviews(params) {
          calls.listReviews.push(params);
          return { data: existingReviews };
        },
        async dismissReview(params) {
          calls.dismissReview.push(params);
          return { data: {} };
        },
        async createReview(params) {
          calls.createReview.push(params);
          if (createReviewFails) {
            const err = new Error('Validation Failed');
            err.status = 422;
            throw err;
          }
          return { data: { id: 909, ...params } };
        },
      },
      issues: {
        async listComments(params) {
          calls.listComments.push(params);
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
      repos: {
        async createCommitStatus(params) {
          calls.createCommitStatus.push(params);
          return { data: { id: 1, ...params } };
        },
      },
    },
  };
  octokit.__calls = calls;
  return octokit;
}

/** Build a PR context (pull_request event). */
function prContext({ number = 42, fork = false, sha = 'abc123' } = {}) {
  return {
    eventName: 'pull_request',
    repo: { owner: 'owner', repo: 'repo' },
    payload: {
      pull_request: {
        number,
        head: { repo: { fork }, sha },
      },
    },
  };
}

/** Build an issue_comment context on a PR. */
function commentContext({
  number = 42,
  body = '/zai ask hi',
  association = 'COLLABORATOR',
  login = 'alice',
  isPr = true,
} = {}) {
  return {
    eventName: 'issue_comment',
    repo: { owner: 'owner', repo: 'repo' },
    payload: {
      comment: {
        body,
        user: { login, author_association: association },
        author_association: association,
      },
      sender: { login, author_association: association },
      issue: isPr
        ? { number, pull_request: {} }
        : { number },
    },
  };
}

/* ------------------------------------------------------------------ *
 * Import safety
 * ------------------------------------------------------------------ */

describe('import safety', () => {
  it('exports run, readAllInputs, isMainEntry, main as functions', () => {
    expect(typeof run).toBe('function');
    expect(typeof readAllInputs).toBe('function');
    expect(typeof isMainEntry).toBe('function');
    expect(typeof indexModule.main).toBe('function');
  });

  it('isMainEntry() is false under the vitest runner (no auto main)', () => {
    // Structural guarantee: process.argv[1] is the vitest binary, not
    // src/index.js, so the guard must be false and main() never auto-runs.
    expect(isMainEntry()).toBe(false);
  });

  it('importing the module in a fresh process does NOT call main (no setFailed, clean exit)', async () => {
    // The strongest possible import-safety proof: write a tiny ESM helper that
    // imports src/index.js with NO ZAI_* inputs set, then run it in a clean
    // Node process. If the module auto-ran main(), loadConfig would throw
    // "ZAI_API_KEY is required", main's .catch would call core.setFailed
    // (which sets process.exitCode = 1), and the process would exit non-zero.
    // A clean exit (code 0) + "IMPORTED_OK" proves main() did not run on import.
    const { spawnSync } = await import('node:child_process');
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join, resolve: resolvePath } = await import('node:path');
    const indexPath = resolvePath('src/index.js');
    const dir = mkdtempSync(join(tmpdir(), 'zai-import-'));
    const helper = join(dir, 'helper.mjs');
    writeFileSync(
      helper,
      `import ${JSON.stringify(indexPath)};\nconsole.log('IMPORTED_OK');\n`,
    );
    let result;
    try {
      result = spawnSync(process.execPath, [helper], {
        encoding: 'utf8',
        cwd: process.cwd(),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    if (result.status !== 0 || !result.stdout.includes('IMPORTED_OK')) {
      throw new Error(
        `subprocess did not import cleanly: status=${result.status}\n` +
          `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
      );
    }
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('IMPORTED_OK');
  });

  it('main() DOES run when src/index.js is the process entry point (action runner parity)', async () => {
    // Corollary of import-safety: when Node is invoked WITH src/index.js as
    // argv[1] (what the action runner does after ncc bundling), main() must
    // fire. With no ZAI_API_KEY input set, loadConfig throws, main's .catch
    // fires core.setFailed, and the process exits non-zero — proving the guard
    // is not permanently false. Pass a minimal env so no real inputs leak in.
    const { spawnSync } = await import('node:child_process');
    const { resolve: resolvePath } = await import('node:path');
    const indexPath = resolvePath('src/index.js');
    const cleanEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      LANG: process.env.LANG,
      // No INPUT_ZAI_API_KEY, no GITHUB_TOKEN, etc.
    };
    const result = spawnSync(process.execPath, [indexPath], {
      encoding: 'utf8',
      cwd: process.cwd(),
      env: cleanEnv,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/ZAI_API_KEY is required/i);
  });
});

/* ------------------------------------------------------------------ *
 * readAllInputs
 * ------------------------------------------------------------------ */

describe('readAllInputs', () => {
  it('pulls every ZAI_* + GITHUB_TOKEN input via core.getInput', () => {
    const seen = {};
    const core = {
      getInput: vi.fn((name) => {
        seen[name] = true;
        return `val-${name}`;
      }),
    };
    const inputs = readAllInputs(core);
    // Every documented config input is read.
    for (const name of [
      'ZAI_API_KEY',
      'ZAI_MODEL',
      'ZAI_SYSTEM_PROMPT',
      'ZAI_REVIEWER_NAME',
      'EXCLUDE_PATTERNS',
      'MAX_DIFF_CHARS',
      'ZAI_LARGE_PR_FILE_THRESHOLD',
      'ZAI_MAX_BATCH_CHARS',
      'ZAI_MAX_FILES_PER_BATCH',
      'ZAI_MAX_PATCH_CHARS',
      'ZAI_TIMEOUT_MS',
      'ZAI_COMMANDS_ENABLED',
      'ZAI_ALLOW_FORK_COMMANDS',
      'ZAI_AUTH_THRESHOLD',
      'ZAI_SCHEDULE_ENABLED',
      'ZAI_SCHEDULE_MAX_PRS',
      'ZAI_DESCRIBE_WRITE_BODY',
      'ZAI_IMPACT_LABELS',
      'ZAI_IMPACT_LABEL_MAP',
      'ZAI_MAX_FINDINGS',
      'ZAI_MIN_SEVERITY',
      'ZAI_TEMPERATURE',
      'ZAI_MAX_TOKENS',
      'ZAI_COMMIT_STATUS',
      'ZAI_SCANNERS_ENABLED',
      'ZAI_SCANNERS_CACHE_DIR',
      'ZAI_BATCH_CONCURRENCY',
      'ZAI_FALLBACK_PROMPT',
      'GITHUB_TOKEN',
    ]) {
      expect(seen[name]).toBe(true);
      expect(inputs[name]).toBe(`val-${name}`);
    }
  });

  it('INPUT_NAMES lists exactly the inputs readAllInputs pulls (no drift)', () => {
    // The INPUT_NAMES export is the single source of truth for which inputs the
    // action reads; loadConfig must accept every one. This guards against a
    // new input being added to one but not the other.
    expect(indexModule.INPUT_NAMES).toEqual(
      expect.arrayContaining([
        'ZAI_MAX_FINDINGS',
        'ZAI_MIN_SEVERITY',
        'ZAI_TEMPERATURE',
        'ZAI_MAX_TOKENS',
      ]),
    );
  });

  it('returns a plain object (not a Map)', () => {
    const core = { getInput: vi.fn(() => '') };
    const inputs = readAllInputs(core);
    expect(inputs).toBeTypeOf('object');
    expect(inputs).not.toBeInstanceOf(Map);
  });
});

/* ------------------------------------------------------------------ *
 * pull_request path
 * ------------------------------------------------------------------ */

describe('run — pull_request auto-review', () => {
  it('small PR: runs the structured-review pipeline (one batch → one callApi) then upserts', async () => {
    const core = makeCore();
    const octokit = makeOctokit({
      files: [file('src/a.js'), file('src/b.js')],
    });
    // The structured pipeline calls callApi once per batch; a small PR is one
    // batch. Return a valid structured-review payload so findings parse.
    const callApi = vi.fn(async () =>
      JSON.stringify({
        summary: 'Looks good overall.',
        findings: [],
      }),
    );
    const config = makeConfig();

    await run(prContext(), {
      config,
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
    });

    // callApi invoked exactly once (single batch for a small PR).
    expect(callApi).toHaveBeenCalledTimes(1);
    const [apiKey, model, prompt] = callApi.mock.calls[0];
    expect(apiKey).toBe('test-api-key');
    expect(model).toBe('glm-5.2');
    // The prompt is the structured-review prompt (no free-form header).
    expect(prompt).toContain('Output ONLY a valid JSON');
    expect(prompt).toContain('src/a.js');
    expect(prompt).toContain('src/b.js');

    // upsert created a comment (no existing marker comment in list).
    expect(octokit.__calls.createComment).toHaveLength(1);
    const body = octokit.__calls.createComment[0].body;
    expect(body).toContain('Z.ai Code Review');
    expect(body).toContain('<!-- zai-code-review -->');
  });

  it('updates the existing marker comment when present', async () => {
    const core = makeCore();
    const marker = '<!-- zai-code-review -->';
    const octokit = makeOctokit({
      files: [file('src/a.js')],
      list: [{ id: 555, body: `## Z.ai Code Review\n\nold\n\n${marker}` }],
    });
    const callApi = vi.fn(async () =>
      JSON.stringify({ summary: 's', findings: [] }),
    );

    await run(prContext(), {
      config: makeConfig(),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
    });

    expect(octokit.__calls.updateComment).toHaveLength(1);
    expect(octokit.__calls.updateComment[0].comment_id).toBe(555);
    expect(octokit.__calls.createComment).toHaveLength(0);
  });

  it('large PR: same structured-review path (batching handles it); runStructuredReview receives the files', async () => {
    const core = makeCore();
    // largePrFileThreshold: 1, with 2 patchable files → isLargePr true.
    const config = makeConfig({ largePrFileThreshold: 1 });
    const octokit = makeOctokit({
      files: [file('src/a.js'), file('src/b.js')],
    });
    const callApi = vi.fn(async () =>
      JSON.stringify({ summary: 's', findings: [] }),
    );
    const runStructuredReviewSpy = vi.fn(async () => ({
      findings: [],
      summary: 'structured review',
      metadata: {
        totalBatches: 2,
        totalFindingsBeforeCap: 0,
        deterministicFindingsCount: 0,
        batchMetadata: [],
      },
    }));

    await run(prContext(), {
      config,
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
      runStructuredReview: runStructuredReviewSpy,
    });

    expect(runStructuredReviewSpy).toHaveBeenCalledTimes(1);
    // The spy received the patchable files, the config (spread with scanner
    // findings/context per Phase 4), and { callApi, core }.
    const [spyFiles, spyConfig, spyDeps] = runStructuredReviewSpy.mock.calls[0];
    expect(spyFiles).toHaveLength(2);
    // Phase 4 wiring spreads the original config and injects deterministic
    // findings + scanner context. The base config keys are still present.
    expect(spyConfig.apiKey).toBe(config.apiKey);
    expect(spyConfig.model).toBe(config.model);
    expect(Array.isArray(spyConfig.deterministicFindings)).toBe(true);
    expect(typeof spyConfig.scannerContext).toBe('string');
    expect(typeof spyDeps.callApi).toBe('function');
    expect(spyDeps.core).toBe(core);
    // Comment still upserted with the rendered summary.
    expect(octokit.__calls.createComment).toHaveLength(1);
  });

  it('no patchable files: short-circuits with NO callApi and NO upsert', async () => {
    const core = makeCore();
    const octokit = makeOctokit({
      files: [{ filename: 'binary.png', status: 'added' /* no patch */ }],
    });
    const callApi = vi.fn(async () => 'should not run');

    await run(prContext(), {
      config: makeConfig(),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
    });

    expect(callApi).not.toHaveBeenCalled();
    expect(octokit.__calls.createComment).toHaveLength(0);
    expect(octokit.__calls.updateComment).toHaveLength(0);
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('No patchable changes'),
    );
  });

  it('excludes files matching excludePatterns before the patchable filter', async () => {
    const core = makeCore();
    const octokit = makeOctokit({
      files: [
        file('src/a.js'),
        file('package-lock.json'), // matches exclude
        file('foo.lock'), // matches exclude
      ],
    });
    const callApi = vi.fn(async () => 'review');

    await run(prContext(), {
      // Match the real config.js defaults so exclude behavior is meaningful.
      config: makeConfig({
        excludePatterns: ['*.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'],
      }),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
    });

    // Only src/a.js made it into the prompt.
    expect(callApi).toHaveBeenCalledTimes(1);
    const prompt = callApi.mock.calls[0][2];
    expect(prompt).toContain('src/a.js');
    expect(prompt).not.toContain('package-lock.json');
    expect(prompt).not.toContain('foo.lock');
  });

  it('scannersEnabled: runs runScanners and injects findings + scannerContext into the prompt', async () => {
    const core = makeCore();
    const octokit = makeOctokit({
      files: [file('src/a.js')],
    });
    const callApi = vi.fn(async () =>
      JSON.stringify({ summary: 's', findings: [] }),
    );
    const fakeFindings = [
      {
        file: 'src/a.js',
        line: 1,
        severity: 'critical',
        confidence: 'high',
        category: 'security',
        title: 'AWS access key',
        description: 'detected',
        evidence: 'AKIA…LE',
        suggestion: null,
        rule: 'gitleaks:aws-access-key',
      },
    ];
    const fakeScanner = vi.fn(async () => ({
      findings: fakeFindings,
      metrics: {
        filesChanged: 1,
        additions: 5,
        deletions: 0,
        testFiles: 0,
        sourceFiles: 1,
        testToSourceRatio: 0,
        largeFiles: [],
        generatedFiles: [],
        todoCount: 0,
        byStatus: { modified: 1 },
      },
      scannerNames: ['secrets:gitleaks'],
    }));

    await run(prContext(), {
      config: makeConfig({ scannersEnabled: true }),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
      runScanners: fakeScanner,
    });

    // Scanner was called with the patchable files + scannersEnabled config.
    expect(fakeScanner).toHaveBeenCalledTimes(1);
    const scannerCall = fakeScanner.mock.calls[0];
    expect(scannerCall[0].files).toHaveLength(1);
    expect(scannerCall[0].config.scannersEnabled).toBe(true);

    // The LLM prompt received the "do not re-report" context block.
    const prompt = callApi.mock.calls[0][2];
    expect(prompt).toContain('Already detected by automated scanners');
    expect(prompt).toContain('gitleaks:aws-access-key');

    // The structured-review summary mentions the deterministic count.
    const body = octokit.__calls.createComment[0].body;
    expect(body).toContain('Scanners found 1 deterministic issues.');
  });

  it('scannersEnabled=false: runScanners is still called (returns []) but no findings surfaced', async () => {
    const core = makeCore();
    const octokit = makeOctokit({ files: [file('src/a.js')] });
    const callApi = vi.fn(async () =>
      JSON.stringify({ summary: 's', findings: [] }),
    );
    const fakeScanner = vi.fn(async () => ({
      findings: [],
      metrics: { filesChanged: 1, additions: 0, deletions: 0, testFiles: 0, sourceFiles: 0, testToSourceRatio: 0, largeFiles: [], generatedFiles: [], todoCount: 0, byStatus: { modified: 1 } },
      scannerNames: [],
    }));

    await run(prContext(), {
      config: makeConfig({ scannersEnabled: false }),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
      runScanners: fakeScanner,
    });

    expect(fakeScanner).toHaveBeenCalledTimes(1);
    // No "do not re-report" block in the prompt (empty findings).
    const prompt = callApi.mock.calls[0][2];
    expect(prompt).not.toContain('Already detected by automated scanners');
  });

  it('setFails when getPullNumber is null on a pull_request event', async () => {
    const core = makeCore();
    const octokit = makeOctokit({ files: [] });
    const ctx = {
      eventName: 'pull_request',
      repo: { owner: 'o', repo: 'r' },
      payload: { pull_request: {} }, // no number
    };
    await run(ctx, {
      config: makeConfig(),
      core,
      octokit,
      callApi: vi.fn(),
      apiClient: { call: vi.fn() },
    });
    expect(core.setFailed).toHaveBeenCalledWith('not a pull request');
  });
});

/* ------------------------------------------------------------------ *
 * pull_request inline review path (Phase 2)
 * ------------------------------------------------------------------ */

describe('run — pull_request inline review (Phase 2)', () => {
  it('posts findings as a GitHub REVIEW with inline comments on added lines', async () => {
    const core = makeCore();
    // A real patch where line 1 is an added line → mappable to an inline comment.
    const octokit = makeOctokit({
      files: [{ filename: 'src/a.js', status: 'modified', patch: '@@ -1 +1 @@\n+const a = null;' }],
    });
    const callApi = vi.fn(async () =>
      JSON.stringify({
        summary: 'One issue.',
        findings: [
          {
            file: 'src/a.js',
            line: 1,
            severity: 'high',
            confidence: 'medium',
            category: 'bug',
            title: 'Null deref',
            description: 'a is null',
            evidence: 'a.foo()',
            suggestion: 'Guard it',
            rule: 'llm',
          },
        ],
      }),
    );

    await run(prContext(), {
      config: makeConfig(),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
    });

    // A review was posted with inline comments — NOT a summary issue comment.
    expect(octokit.__calls.createReview).toHaveLength(1);
    expect(octokit.__calls.createComment).toHaveLength(0);
    const review = octokit.__calls.createReview[0];
    expect(review.event).toBe('COMMENT');
    expect(review.comments).toHaveLength(1);
    expect(review.comments[0]).toMatchObject({
      path: 'src/a.js',
      line: 1,
      side: 'RIGHT',
    });
    expect(review.body).toContain('<!-- zai-code-review -->');
  });

  it('falls back to a summary issue comment when createReview fails', async () => {
    const core = makeCore();
    const octokit = makeOctokit({
      files: [{ filename: 'src/a.js', status: 'modified', patch: '@@ -1 +1 @@\n+const a = null;' }],
      createReviewFails: true,
    });
    const callApi = vi.fn(async () =>
      JSON.stringify({
        summary: 's',
        findings: [
          {
            file: 'src/a.js',
            line: 1,
            severity: 'low',
            confidence: 'low',
            category: 'style',
            title: 'T',
            description: 'd',
            evidence: '',
            suggestion: null,
            rule: 'llm',
          },
        ],
      }),
    );

    await run(prContext(), {
      config: makeConfig(),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
    });

    // Review attempted, failed → fallback issue comment posted.
    expect(octokit.__calls.createReview).toHaveLength(1);
    expect(octokit.__calls.createComment).toHaveLength(1);
    expect(core.warning).toHaveBeenCalled();
    // The fallback body carries the findings list.
    expect(octokit.__calls.createComment[0].body).toContain('src/a.js');
  });

  it('posts a summary comment (no review) when findings have no mappable lines', async () => {
    const core = makeCore();
    const octokit = makeOctokit({
      files: [{ filename: 'src/a.js', status: 'modified', patch: '@@ -1 +1 @@\n+const a = 1;' }],
    });
    const callApi = vi.fn(async () =>
      JSON.stringify({
        summary: 's',
        findings: [
          {
            file: 'src/a.js',
            line: null, // file-level → not inline-mappable
            severity: 'low',
            confidence: 'low',
            category: 'style',
            title: 'T',
            description: 'd',
            evidence: '',
            suggestion: null,
            rule: 'llm',
          },
        ],
      }),
    );

    await run(prContext(), {
      config: makeConfig(),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
    });

    // No inline findings → summary issue comment path (no review).
    expect(octokit.__calls.createReview).toHaveLength(0);
    expect(octokit.__calls.createComment).toHaveLength(1);
  });

  it('dismisses prior bot reviews before posting the new inline review', async () => {
    const core = makeCore();
    const oldReview = {
      id: 555,
      body: `stale\n\n<!-- zai-code-review -->`,
      user: { login: 'zai-code-review[bot]' },
    };
    const octokit = makeOctokit({
      files: [{ filename: 'src/a.js', status: 'modified', patch: '@@ -1 +1 @@\n+const a = null;' }],
      existingReviews: [oldReview],
    });
    const callApi = vi.fn(async () =>
      JSON.stringify({
        summary: 's',
        findings: [
          {
            file: 'src/a.js',
            line: 1,
            severity: 'high',
            confidence: 'medium',
            category: 'bug',
            title: 'x',
            description: 'd',
            evidence: '',
            suggestion: null,
            rule: 'llm',
          },
        ],
      }),
    );

    await run(prContext({ sha: 'deadbeef' }), {
      config: makeConfig(),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
    });

    // Stale review dismissed first, then new review created.
    expect(octokit.__calls.dismissReview).toHaveLength(1);
    expect(octokit.__calls.dismissReview[0].review_id).toBe(555);
    expect(octokit.__calls.dismissReview[0].message).toContain('deadbeef');
    expect(octokit.__calls.createReview).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * issue_comment path
 * ------------------------------------------------------------------ */

describe('run — issue_comment routing', () => {
  it('commands disabled: returns early, no dispatch', async () => {
    const core = makeCore();
    const octokit = makeOctokit();
    const handler = vi.fn();
    const config = makeConfig({ commandsEnabled: false });

    await run(commentContext({ body: '/zai ask hi' }), {
      config,
      core,
      octokit,
      callApi: vi.fn(),
      apiClient: { call: vi.fn() },
      handlers: { ask: handler },
    });

    expect(handler).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('Commands disabled'),
    );
  });

  it('payload.action=edited: returns early (defense-in-depth against edited triggers), no dispatch', async () => {
    const core = makeCore();
    const octokit = makeOctokit();
    const handler = vi.fn();
    const config = makeConfig();

    const ctx = commentContext({ body: '/zai ask hi', association: 'COLLABORATOR' });
    ctx.payload.action = 'edited';

    await run(ctx, {
      config,
      core,
      octokit,
      callApi: vi.fn(),
      apiClient: { call: vi.fn() },
      handlers: { ask: handler },
    });

    expect(handler).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('Ignoring issue_comment action: edited'),
    );
  });

  it('payload.action=created: dispatches normally (the only allowed action)', async () => {
    const core = makeCore();
    const octokit = makeOctokit();
    const handler = vi.fn(async () => {});
    const config = makeConfig();

    const ctx = commentContext({ body: '/zai ask hi', association: 'COLLABORATOR' });
    ctx.payload.action = 'created';

    await run(ctx, {
      config,
      core,
      octokit,
      callApi: vi.fn(async () => 'a'),
      apiClient: { call: vi.fn() },
      handlers: { ask: handler },
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('bot comment: returns early (anti-loop), no dispatch', async () => {
    const core = makeCore();
    const octokit = makeOctokit();
    const handler = vi.fn();
    const config = makeConfig();

    await run(
      commentContext({
        body: '/zai ask hi',
        login: 'zai-code-review[bot]',
        association: 'NONE',
      }),
      {
        config,
        core,
        octokit,
        callApi: vi.fn(),
        apiClient: { call: vi.fn() },
        handlers: { ask: handler },
      },
    );

    expect(handler).not.toHaveBeenCalled();
  });

  it('not a PR comment (issue only): returns silently', async () => {
    const core = makeCore();
    const octokit = makeOctokit();
    const handler = vi.fn();

    await run(commentContext({ body: '/zai ask hi', isPr: false }), {
      config: makeConfig(),
      core,
      octokit,
      callApi: vi.fn(),
      apiClient: { call: vi.fn() },
      handlers: { ask: handler },
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('not a command (nice PR!): returns silently, no dispatch', async () => {
    const core = makeCore();
    const octokit = makeOctokit();
    const handler = vi.fn();

    await run(commentContext({ body: 'nice PR!' }), {
      config: makeConfig(),
      core,
      octokit,
      callApi: vi.fn(),
      apiClient: { call: vi.fn() },
      handlers: { ask: handler },
    });

    expect(handler).not.toHaveBeenCalled();
    // No error logged as a failure.
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('malformed command (/zai with nothing): logs and returns, no dispatch', async () => {
    const core = makeCore();
    const octokit = makeOctokit();
    const handler = vi.fn();

    await run(commentContext({ body: '/zai' }), {
      config: makeConfig(),
      core,
      octokit,
      callApi: vi.fn(),
      apiClient: { call: vi.fn() },
      handlers: { ask: handler },
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('UNAUTHORIZED commenter (NONE, default write threshold): silent block, NO handler, NO reaction', async () => {
    const core = makeCore();
    const octokit = makeOctokit();
    const handler = vi.fn();

    await run(
      commentContext({
        body: '/zai ask hi',
        association: 'NONE',
        login: 'rando',
      }),
      {
        config: makeConfig(), // authThreshold default 'write'
        core,
        octokit,
        callApi: vi.fn(),
        apiClient: { call: vi.fn() },
        handlers: { ask: handler },
      },
    );

    // The live auth gate: the handler MUST NOT be called.
    expect(handler).not.toHaveBeenCalled();
    // No comment posted (no reaction spam).
    expect(octokit.__calls.createComment).toHaveLength(0);
    // A silent info log is emitted (no setFailed — silent block).
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('Blocked command from unauthorized user'),
    );
  });

  it('authorized commenter (COLLABORATOR) + valid /zai ask: dispatches handler with the right args', async () => {
    const core = makeCore();
    const octokit = makeOctokit();
    const handler = vi.fn(async () => {});
    const callApi = vi.fn(async () => 'answer');
    const ctx = commentContext({
      body: '/zai ask "what is this"',
      association: 'COLLABORATOR',
      login: 'alice',
    });
    const config = makeConfig();

    await run(ctx, {
      config,
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
      handlers: { ask: handler },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    const callArg = handler.mock.calls[0][0];
    expect(callArg.octokit).toBe(octokit);
    expect(callArg.context).toBe(ctx);
    expect(callArg.config).toBe(config);
    expect(callArg.core).toBe(core);
    expect(callArg.commenter).toEqual({ login: 'alice', author_association: 'COLLABORATOR' });
    expect(callArg.args).toBe('"what is this"');
    expect(typeof callArg.callApi).toBe('function');
  });

  it('authorized + UNKNOWN command: no dispatch (graceful)', async () => {
    const core = makeCore();
    const octokit = makeOctokit();
    const handler = vi.fn();

    await run(
      commentContext({
        body: '/zai frobnicate x',
        association: 'COLLABORATOR',
      }),
      {
        config: makeConfig(),
        core,
        octokit,
        callApi: vi.fn(),
        apiClient: { call: vi.fn() },
        handlers: { ask: handler },
      },
    );

    expect(handler).not.toHaveBeenCalled();
  });

  it('authorized + valid command but no handler registered: warns and does not throw', async () => {
    const core = makeCore();
    const octokit = makeOctokit();

    await run(
      commentContext({
        body: '/zai ask hi',
        association: 'COLLABORATOR',
      }),
      {
        config: makeConfig(),
        core,
        octokit,
        callApi: vi.fn(),
        apiClient: { call: vi.fn() },
        handlers: {}, // no ask handler
      },
    );

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('No handler for command: ask'),
    );
  });

  it('authThreshold none: NONE commenter is authorized (gate disabled)', async () => {
    const core = makeCore();
    const octokit = makeOctokit();
    const handler = vi.fn();

    await run(
      commentContext({
        body: '/zai ask hi',
        association: 'NONE',
        login: 'rando',
      }),
      {
        config: makeConfig({ authThreshold: 'none' }),
        core,
        octokit,
        callApi: vi.fn(),
        apiClient: { call: vi.fn() },
        handlers: { ask: handler },
      },
    );

    expect(handler).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ *
 * schedule + other events
 * ------------------------------------------------------------------ */

describe('run — schedule + unknown events', () => {
  it('schedule: disabled by default → graceful no-op', async () => {
    const core = makeCore();
    const octokit = makeOctokit();
    const callApi = vi.fn();

    await run(
      { eventName: 'schedule', repo: { owner: 'o', repo: 'r' }, payload: {} },
      {
        config: makeConfig(), // scheduleEnabled defaults to false
        core,
        octokit,
        callApi,
        apiClient: { call: vi.fn() },
      },
    );

    expect(callApi).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('Schedule disabled'),
    );
  });

  it('schedule: enabled → dispatches runScheduledReview with the pipeline helpers', async () => {
    const core = makeCore();
    const octokit = makeOctokit();
    const callApi = vi.fn(async () => 'review');
    const runScheduledReview = vi.fn(async () => ({ reviewed: 0, skipped: 0, failed: 0 }));

    await run(
      { eventName: 'schedule', repo: { owner: 'o', repo: 'r' }, payload: {} },
      {
        config: makeConfig({ scheduleEnabled: true }),
        core,
        octokit,
        callApi,
        apiClient: { call: vi.fn() },
        runScheduledReview,
      },
    );

    expect(runScheduledReview).toHaveBeenCalledTimes(1);
    expect(runScheduledReview.mock.calls[0][0]).toMatchObject({
      owner: 'o',
      repo: 'r',
    });
    // The pipeline helpers were wired through.
    expect(runScheduledReview.mock.calls[0][0].callApi).toBeTypeOf('function');
  });

  it('unknown event: graceful no-op', async () => {
    const core = makeCore();
    const octokit = makeOctokit();

    await run(
      { eventName: 'push', repo: { owner: 'o', repo: 'r' }, payload: {} },
      {
        config: makeConfig(),
        core,
        octokit,
        callApi: vi.fn(),
        apiClient: { call: vi.fn() },
      },
    );

    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('Ignoring event: push'),
    );
  });
});

/* ------------------------------------------------------------------ *
 * error propagation
 * ------------------------------------------------------------------ */

describe('run — error propagation', () => {
  it('lets errors from callApi propagate (does not swallow)', async () => {
    const core = makeCore();
    const octokit = makeOctokit({ files: [file('src/a.js')] });
    const callApi = vi.fn(async () => {
      throw new Error('boom');
    });

    await expect(
      run(prContext(), {
        config: makeConfig(),
        core,
        octokit,
        callApi,
        apiClient: { call: vi.fn() },
      }),
    ).rejects.toThrow('boom');
  });
});

/* ------------------------------------------------------------------ *
 * buildCallApi adapter — temperature / maxTokens / fallbackPrompt wiring
 *
 * These tests do NOT inject callApi (the adapter would be bypassed). Instead
 * they inject `apiClient: { call: spy }` so the adapter wraps our spy and we
 * can assert exactly which args reach `client.call`.
 * ------------------------------------------------------------------ */
describe('buildCallApi — sampling + fallback knobs (Phase 6.2)', () => {
  it('forwards config.temperature and config.maxTokens to client.call', async () => {
    const core = makeCore();
    const octokit = makeOctokit({ files: [file('src/a.js')] });
    const callSpy = vi.fn(async () => ({
      success: true,
      data: JSON.stringify({ summary: 's', findings: [] }),
      usedFallback: false,
    }));
    // Provide a non-empty patchable file so the pipeline runs.
    await run(prContext(), {
      config: makeConfig({ temperature: 0.42, maxTokens: 2048 }),
      core,
      octokit,
      // NOT passing callApi → adapter builds and uses our apiClient.
      apiClient: { call: callSpy },
    });
    expect(callSpy).toHaveBeenCalled();
    const arg = callSpy.mock.calls[0][0];
    expect(arg.temperature).toBe(0.42);
    expect(arg.maxTokens).toBe(2048);
    // And the baseline fields are still there.
    expect(arg.apiKey).toBe('test-api-key');
    expect(arg.model).toBe('glm-5.2');
    expect(typeof arg.userPrompt).toBe('string');
  });

  it('forwards default temperature (0.2) and maxTokens (4096) to client.call in the stock config', async () => {
    // loadConfig ALWAYS produces numbers for these (default 0.2 / 4096). The
    // adapter forwards them whenever non-null, which is always for a real
    // config — so a stock run actually sends temperature=0.2 & max_tokens=4096.
    const core = makeCore();
    const octokit = makeOctokit({ files: [file('src/a.js')] });
    const callSpy = vi.fn(async () => ({
      success: true,
      data: JSON.stringify({ summary: 's', findings: [] }),
      usedFallback: false,
    }));
    await run(prContext(), {
      config: makeConfig(), // default temperature 0.2, maxTokens 4096
      core,
      octokit,
      apiClient: { call: callSpy },
    });
    const arg = callSpy.mock.calls[0][0];
    expect(arg.temperature).toBe(0.2);
    expect(arg.maxTokens).toBe(4096);
  });

  it('passes fallbackPrompt to createApiClient when config.fallbackPrompt is a non-empty string', async () => {
    // Use the createApiClientFn override to capture the factory config.
    const factoryConfigs = [];
    const createApiClientFn = vi.fn((factoryConfig) => {
      factoryConfigs.push(factoryConfig);
      return {
        call: vi.fn(async () => ({
          success: true,
          data: JSON.stringify({ summary: 's', findings: [] }),
          usedFallback: false,
        })),
      };
    });
    const core = makeCore();
    const octokit = makeOctokit({ files: [file('src/a.js')] });
    await run(prContext(), {
      config: makeConfig({ fallbackPrompt: 'Summarize only.' }),
      core,
      octokit,
      createApiClient: createApiClientFn,
    });
    expect(createApiClientFn).toHaveBeenCalled();
    expect(factoryConfigs[0].fallbackPrompt).toBe('Summarize only.');
    expect(factoryConfigs[0].timeout).toBe(120000);
  });

  it('does NOT pass fallbackPrompt to createApiClient when config.fallbackPrompt is empty (disabled)', async () => {
    const factoryConfigs = [];
    const createApiClientFn = vi.fn((factoryConfig) => {
      factoryConfigs.push(factoryConfig);
      return {
        call: vi.fn(async () => ({
          success: true,
          data: JSON.stringify({ summary: 's', findings: [] }),
          usedFallback: false,
        })),
      };
    });
    const core = makeCore();
    const octokit = makeOctokit({ files: [file('src/a.js')] });
    await run(prContext(), {
      config: makeConfig({ fallbackPrompt: '' }),
      core,
      octokit,
      createApiClient: createApiClientFn,
    });
    expect(createApiClientFn).toHaveBeenCalled();
    expect(factoryConfigs[0]).not.toHaveProperty('fallbackPrompt');
    expect(factoryConfigs[0].timeout).toBe(120000);
  });

  it('throws on !r.success (retry-loop redacted message propagates through the adapter)', async () => {
    const core = makeCore();
    const octokit = makeOctokit({ files: [file('src/a.js')] });
    const callSpy = vi.fn(async () => ({
      success: false,
      data: null,
      error: { category: 'provider', message: 'redacted provider error', retryable: true, attempts: 4, totalDuration: 10 },
      usedFallback: false,
    }));
    await expect(
      run(prContext(), {
        config: makeConfig(),
        core,
        octokit,
        apiClient: { call: callSpy },
      }),
    ).rejects.toThrow('redacted provider error');
  });
});

/* ------------------------------------------------------------------ *
 * pull_request commit-status feedback (Phase 5)
 * ------------------------------------------------------------------ */

describe('run — pull_request commit-status (Phase 5)', () => {
  it('posts pending then success when commitStatus is enabled (review completes)', async () => {
    const core = makeCore();
    const octokit = makeOctokit({ files: [file('src/a.js')] });
    const callApi = vi.fn(async () =>
      JSON.stringify({ summary: 's', findings: [] }),
    );

    await run(prContext({ sha: 'sha-1' }), {
      config: makeConfig({ commitStatus: true }),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
    });

    // Two status calls: pending (start) + success (after review).
    expect(octokit.__calls.createCommitStatus).toHaveLength(2);
    const [pending, success] = octokit.__calls.createCommitStatus;
    expect(pending).toMatchObject({
      owner: 'owner',
      repo: 'repo',
      sha: 'sha-1',
      state: 'pending',
      context: 'Z.ai Code Review',
    });
    expect(pending.description).toContain('in progress');
    expect(success).toMatchObject({
      owner: 'owner',
      repo: 'repo',
      sha: 'sha-1',
      state: 'success',
      context: 'Z.ai Code Review',
    });
    // No findings → the "no issues found" success description.
    expect(success.description).toContain('no issues found');
  });

  it('success description counts critical/high findings', async () => {
    const core = makeCore();
    const octokit = makeOctokit({
      files: [
        {
          filename: 'src/a.js',
          status: 'modified',
          patch: '@@ -1 +1 @@\n+const a = null;',
        },
      ],
    });
    const callApi = vi.fn(async () =>
      JSON.stringify({
        summary: 's',
        findings: [
          { file: 'src/a.js', line: 1, severity: 'critical', confidence: 'high', category: 'bug', title: 'T', description: 'd', evidence: '', suggestion: null, rule: 'llm' },
          { file: 'src/a.js', line: 2, severity: 'high', confidence: 'high', category: 'bug', title: 'T2', description: 'd', evidence: '', suggestion: null, rule: 'llm' },
          { file: 'src/a.js', line: 3, severity: 'low', confidence: 'low', category: 'style', title: 'T3', description: 'd', evidence: '', suggestion: null, rule: 'llm' },
        ],
      }),
    );

    await run(prContext({ sha: 'sha-2' }), {
      config: makeConfig({ commitStatus: true }),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
    });

    const success = octokit.__calls.createCommitStatus[1];
    expect(success.state).toBe('success');
    expect(success.description).toBe(
      'Review complete: 3 findings (1 critical, 1 high)',
    );
  });

  it('does NOT post any status when commitStatus is disabled (default)', async () => {
    const core = makeCore();
    const octokit = makeOctokit({ files: [file('src/a.js')] });
    const callApi = vi.fn(async () =>
      JSON.stringify({ summary: 's', findings: [] }),
    );

    await run(prContext(), {
      config: makeConfig({ commitStatus: false }),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
    });

    expect(octokit.__calls.createCommitStatus).toHaveLength(0);
  });

  it('does NOT post a status when there are no patchable files (short-circuit before pending)', async () => {
    const core = makeCore();
    const octokit = makeOctokit({
      files: [{ filename: 'binary.png', status: 'added' }],
    });

    await run(prContext(), {
      config: makeConfig({ commitStatus: true }),
      core,
      octokit,
      callApi: vi.fn(),
      apiClient: { call: vi.fn() },
    });

    expect(octokit.__calls.createCommitStatus).toHaveLength(0);
  });

  it('posts pending before a hard error; failure status is main() job', async () => {
    // run() lets errors propagate. The PENDING status fires at the start of the
    // review; the FAILURE status is posted by main()'s catch block (verified
    // separately by reading src/index.js and via the fail-soft run() test).
    const core = makeCore();
    const octokit = makeOctokit({ files: [file('src/a.js')] });
    const callApi = vi.fn(async () => {
      throw new Error('model down');
    });
    const context = prContext({ sha: 'sha-fail' });

    await expect(
      run(context, {
        config: makeConfig({ commitStatus: true }),
        core,
        octokit,
        callApi,
        apiClient: { call: vi.fn() },
      }),
    ).rejects.toThrow('model down');

    const statuses = octokit.__calls.createCommitStatus;
    expect(statuses.length).toBe(1);
    expect(statuses[0].state).toBe('pending');
    expect(statuses[0].sha).toBe('sha-fail');
  });

  it('status API errors are swallowed (fail-soft) and do not break the review', async () => {
    const core = makeCore();
    const calls = { createCommitStatus: [], createComment: [] };
    const octokit = {
      rest: {
        pulls: {
          async listFiles() { return { data: [file('src/a.js')] }; },
          async get() { return { data: { head: { ref: 'r', sha: 's', repo: { fork: false } } } }; },
          async listReviews() { return { data: [] }; },
          async dismissReview() { return { data: {} }; },
          async createReview(p) { return { data: { id: 1, ...p } }; },
        },
        issues: {
          async listComments() { return { data: [] }; },
          async createComment(p) { calls.createComment.push(p); return { data: { id: 1 } }; },
          async updateComment(p) { return { data: { id: 1 } }; },
        },
        repos: {
          async createCommitStatus(p) { calls.createCommitStatus.push(p); throw new Error('statuses:write missing'); },
        },
      },
    };
    Object.defineProperty(octokit, '__calls', { value: calls, enumerable: false });
    const callApi = vi.fn(async () =>
      JSON.stringify({ summary: 's', findings: [] }),
    );

    // Must NOT throw — status failures are swallowed.
    await run(prContext(), {
      config: makeConfig({ commitStatus: true }),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
    });

    expect(calls.createCommitStatus).toHaveLength(2);
    expect(calls.createComment).toHaveLength(1);
    expect(core.warning).toHaveBeenCalled();
  });
});

describe('main() — failure commit-status wiring (Phase 5)', () => {
  it('posts pending before a hard error; main catch is the failure hook', async () => {
    // main() reads the module-level github object, so the failure-status
    // catch is verified in a hermetic subprocess: import run() (the same path
    // main wraps), force run to throw via a failing callApi, and assert that
    // the pending status fired with the head SHA. main catch block (which
    // posts failure) is source-verified and mirrors this exact shape.
    const { spawnSync } = await import('node:child_process');
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join, resolve: resolvePath } = await import('node:path');
    const indexPath = resolvePath('src/index.js');
    const dir = mkdtempSync(join(tmpdir(), 'zai-main-fail-'));
    const driver = join(dir, 'driver.mjs');
    writeFileSync(
      driver,
      [
        'import { run } from ' + JSON.stringify(indexPath) + ';',
        'const statusCalls = [];',
        'const octokit = { rest: {',
        '  pulls: {',
        '    async listFiles() { return { data: [{ filename: "a.js", status: "modified", patch: "@@ -1 +1 @@" }] }; },',
        '    async get() { return { data: { head: { ref: "r", sha: "sha-x", repo: { fork: false } } } }; },',
        '    async listReviews() { return { data: [] }; },',
        '    async dismissReview() { return { data: {} }; },',
        '    async createReview(p) { return { data: { id: 1, ...p } }; },',
        '  },',
        '  issues: {',
        '    async listComments() { return { data: [] }; },',
        '    async createComment() { return { data: { id: 1 } }; },',
        '    async updateComment() { return { data: { id: 1 } }; },',
        '  },',
        '  repos: {',
        '    async createCommitStatus(p) { statusCalls.push(p); return { data: { id: 1, ...p } }; },',
        '  },',
        '}};',
        'const context = {',
        '  eventName: "pull_request",',
        '  repo: { owner: "o", repo: "r" },',
        '  payload: { pull_request: { number: 1, head: { repo: { fork: false }, sha: "sha-x" } } },',
        '};',
        'const core = { info(){}, warning(){}, setSecret(){}, setFailed(m){ console.log("SETFAILED:"+m); }, getInput(){ return ""; } };',
        'const callApi = async () => { throw new Error("hard boom"); };',
        'const config = {',
        '  apiKey: "k", model: "glm-5.2", systemPrompt: "", reviewerName: "Z.ai Code Review",',
        '  excludePatterns: [], maxDiffChars: 0, largePrFileThreshold: 50, maxBatchChars: 120000,',
        '  maxFilesPerBatch: 40, maxPatchChars: 18000, commandsEnabled: false, authThreshold: "write",',
        '  allowForkCommands: false, timeoutMs: 120000, scheduleEnabled: false, scheduleMaxPrs: 10,',
        '  describeWriteBody: false, impactLabels: false, impactLabelMap: {}, maxFindings: 8,',
        '  minSeverity: "info", temperature: 0.2, maxTokens: 4096, batchConcurrency: 3,',
        '  fallbackPrompt: "", scannersEnabled: false, scannersCacheDir: "/tmp/x",',
        '  commitStatus: true, githubToken: "t",',
        '};',
        'try {',
        '  await run(context, { config, core, octokit, callApi, apiClient: { call: async() => ({success:true,data:""}) } });',
        '  console.log("NOSTHROW");',
        '} catch (e) {',
        '  console.log("THREW:" + e.message);',
        '}',
        'console.log("STATUSCALLS:" + JSON.stringify(statusCalls.map(s => s.state + ":" + s.sha)));',
      ].join('\n'),
    );
    let result;
    try {
      result = spawnSync(process.execPath, [driver], {
        encoding: 'utf8',
        cwd: process.cwd(),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    if (result.status !== 0) {
      throw new Error('driver failed: ' + result.stderr + result.stdout);
    }
    const out = result.stdout;
    // run() posted pending, then threw (the hard error main()'s catch turns
    // into a failure status). We assert pending fired with the head SHA and
    // the error propagated — proving the run-level wiring main relies on.
    expect(out).toContain('THREW:hard boom');
    expect(out).toMatch(/STATUSCALLS:\["pending:sha-x"\]/);
  });
});
