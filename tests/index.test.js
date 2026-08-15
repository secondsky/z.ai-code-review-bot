/**
 * Tests for src/index.js — the GitHub Action entry point + event router.
 *
 * Every external collaborator is injected: octokit, core, callApi, apiClient,
 * handlers, and the runStructuredReview override. Tests never touch the
 * network or GitHub. The module MUST be importable without triggering main().
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { hashFinding } from '../src/lib/findings.js';

// Dynamic import so we can assert import-safety AFTER spying on core.setFailed.
// We re-import per test group where side effects matter.
const indexModule = await import('../src/index.js');
const { run, readAllInputs, isMainEntry, createScannerDeps, httpsGet } = indexModule;

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
    // Phase 3: in-repo `.zai.yml`. Default OFF in unit tests so loadRepoConfig
    // (which would hit octokit.repos.getContent) is skipped; dedicated
    // repo-config tests opt in or inject loadRepoConfig directly.
    repoConfigEnabled: false,
    walkthrough: true,
    // Phase 6.3: incremental review. Default OFF in unit tests so existing
    // assertions on the review body stay stable (no hash block appended, no
    // suppression); dedicated incremental tests opt in.
    incrementalReview: false,
    // Phase 8.3: strict review mode. Default OFF in tests; dedicated strict
    // tests opt in. When on + a critical/high finding exists, the inline
    // review is submitted as REQUEST_CHANGES instead of COMMENT.
    strictMode: false,
    // Phase 8.1: CODEOWNERS reviewer suggestions. Default OFF in unit tests so
    // loadCodeowners (which would hit octokit.rest.repos.getContent) is
    // skipped; dedicated codeowners tests opt in or inject loadCodeowners.
    suggestReviewers: false,
    autoAssignReviewers: false,
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
  codeownersContent = '',
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
    requestReviewers: [],
    getContent: [],
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
        async requestReviewers(params) {
          calls.requestReviewers.push(params);
          return { data: { ...params } };
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
        async getContent(params) {
          calls.getContent.push(params);
          // Default: no CODEOWNERS (404). Tests that need CODEOWNERS inject
          // their own octokit or use the `codeowners` field on makeOctokit.
          if (codeownersContent) {
            return {
              data: {
                content: Buffer.from(codeownersContent, 'utf8').toString('base64'),
                encoding: 'base64',
              },
            };
          }
          const err = new Error('Not Found');
          err.status = 404;
          throw err;
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
      list: [{ id: 555, body: `## Z.ai Code Review\n\nold\n\n${marker}`, user: { login: 'github-actions[bot]', type: 'Bot' } }],
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

  // ------------------------------------------------------------------
  // W6-1: .zai.yml `path_filters` must actually filter files. The merge
  // computes repoConfig.excludePatterns (action patterns UNION repo
  // path_filters), but it was never applied — filtering happened BEFORE the
  // merge using only config.excludePatterns. Files the operator excluded via
  // .zai.yml were still sent to the LLM and scanned.
  // ------------------------------------------------------------------
  it('W6-1: .zai.yml path_filters are applied to exclude files from review', async () => {
    const core = makeCore();
    const octokit = makeOctokit({
      files: [file('src/a.js'), file('generated/out.js')],
    });
    const callApi = vi.fn(async () =>
      JSON.stringify({ summary: 's', findings: [] }),
    );
    const runStructuredReviewSpy = vi.fn(async () => ({
      findings: [],
      summary: 'structured review',
      metadata: { totalBatches: 1, totalFindingsBeforeCap: 0, deterministicFindingsCount: 0, batchMetadata: [] },
    }));
    // Inject mergeRepoConfig to return excludePatterns that drop generated/**.
    const mergeRepoConfigSpy = vi.fn(() => ({
      excludePatterns: ['generated/**'],
      maxFindings: 8,
    }));

    await run(prContext(), {
      config: makeConfig({ repoConfigEnabled: true }),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
      runStructuredReview: runStructuredReviewSpy,
      mergeRepoConfig: mergeRepoConfigSpy,
      loadRepoConfig: vi.fn(async () => ({})),
    });

    const [spyFiles] = runStructuredReviewSpy.mock.calls[0];
    // generated/out.js must be filtered out; only src/a.js remains.
    expect(spyFiles).toHaveLength(1);
    expect(spyFiles[0].filename).toBe('src/a.js');
  });

  // ------------------------------------------------------------------
  // W6-2: .zai.yml `profile: chill` sets minSeverity='high' in the merged
  // config, but it was never passed to runStructuredReview — the spread
  // `...config` carried the action's minSeverity ('info'), overriding the
  // repo's narrowing. Medium/low/info findings that chill should have filtered
  // were still posted.
  // ------------------------------------------------------------------
  it('W6-2: .zai.yml profile:chill narrows minSeverity passed to runStructuredReview', async () => {
    const core = makeCore();
    const octokit = makeOctokit({ files: [file('src/a.js')] });
    const callApi = vi.fn(async () =>
      JSON.stringify({ summary: 's', findings: [] }),
    );
    const runStructuredReviewSpy = vi.fn(async () => ({
      findings: [],
      summary: 'structured review',
      metadata: { totalBatches: 1, totalFindingsBeforeCap: 0, deterministicFindingsCount: 0, batchMetadata: [] },
    }));
    // chill narrows the floor: minSeverity becomes 'high'.
    const mergeRepoConfigSpy = vi.fn(() => ({
      minSeverity: 'high',
      profile: 'chill',
      maxFindings: 8,
    }));

    await run(prContext(), {
      config: makeConfig({ repoConfigEnabled: true, minSeverity: 'info' }),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
      runStructuredReview: runStructuredReviewSpy,
      mergeRepoConfig: mergeRepoConfigSpy,
      loadRepoConfig: vi.fn(async () => ({})),
    });

    const [, spyConfig] = runStructuredReviewSpy.mock.calls[0];
    // The chill-narrowed minSeverity must reach runStructuredReview.
    expect(spyConfig.minSeverity).toBe('high');
  });

  // ------------------------------------------------------------------
  // W15-A1-2: `.zai.yml` `scanners.metrics: false` was dropped by the
  // validator (key not in SCANNER_KEYS) and index.js never mapped a metrics
  // key into scannerRepoConfig — so action.yml's documented "repo-level
  // .zai.yml can DISABLE individual scanners (secrets, patterns, metrics)"
  // was impossible for metrics. The merged repo scanners must wire through to
  // runScanners' per-scanner toggles.
  // ------------------------------------------------------------------
  it('W15-A1-2: .zai.yml scanners.metrics:false disables the metrics scanner via runScanners', async () => {
    const core = makeCore();
    const octokit = makeOctokit({ files: [file('src/a.js')] });
    const callApi = vi.fn(async () =>
      JSON.stringify({ summary: 's', findings: [] }),
    );
    const runStructuredReviewSpy = vi.fn(async () => ({
      findings: [],
      summary: 'structured review',
      metadata: { totalBatches: 1, totalFindingsBeforeCap: 0, deterministicFindingsCount: 0, batchMetadata: [] },
    }));
    const runScannersSpy = vi.fn(async () => ({
      findings: [],
      metrics: { filesChanged: 1 },
      scannerNames: [],
    }));
    // mergeRepoConfig passes repo scanners.{secrets,patterns,metrics} through
    // as DISABLE-only flags (metrics: false here, gitleaks/ast_grep default).
    const mergeRepoConfigSpy = vi.fn(() => ({
      scanners: { gitleaks: true, ast_grep: true, metrics: false },
      maxFindings: 8,
    }));

    await run(prContext(), {
      config: makeConfig({ repoConfigEnabled: true }),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
      runStructuredReview: runStructuredReviewSpy,
      runScanners: runScannersSpy,
      mergeRepoConfig: mergeRepoConfigSpy,
      loadRepoConfig: vi.fn(async () => ({})),
    });

    expect(runScannersSpy).toHaveBeenCalledTimes(1);
    const repoConfigArg = runScannersSpy.mock.calls[0][0].repoConfig;
    expect(repoConfigArg.scanners.metrics).toBe(false);
    // The other two toggles stay undefined (action default — enabled).
    expect(repoConfigArg.scanners.secrets).toBeUndefined();
    expect(repoConfigArg.scanners.patterns).toBeUndefined();
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

    // The deterministic scanner finding reached the PR summary body. (The
    // exact summary format varies by rendering phase — walkthrough vs flat —
    // so we assert the finding's title/rule appear rather than a specific
    // summary line.)
    const body = octokit.__calls.createComment[0].body;
    expect(body).toContain('AWS access key');
    expect(body).toContain('src/a.js');
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

  it('setFails gracefully when context.repo is undefined (no TypeError)', async () => {
    // A pull_request event whose context.repo is missing must NOT crash with a
    // TypeError on destructuring; it should set a failure status and return.
    const core = makeCore();
    const octokit = makeOctokit({ files: [] });
    const ctx = {
      eventName: 'pull_request',
      // context.repo is undefined — destructuring `{ owner, repo }` must not throw.
      payload: { pull_request: { number: 42 } },
    };
    await expect(
      run(ctx, {
        config: makeConfig(),
        core,
        octokit,
        callApi: vi.fn(),
        apiClient: { call: vi.fn() },
      }),
    ).resolves.toBeUndefined();
    expect(core.setFailed).toHaveBeenCalled();
  });

  /* ---- INT-2: pull_request action allowlist ---- */

  it('payload.action=closed: returns early (no review), no callApi', async () => {
    const core = makeCore();
    const octokit = makeOctokit({ files: [file('src/a.js')] });
    const callApi = vi.fn(async () => JSON.stringify({ summary: 's', findings: [] }));
    const ctx = prContext();
    ctx.payload.action = 'closed';

    await run(ctx, {
      config: makeConfig(),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
    });

    expect(callApi).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('Ignoring pull_request action: closed'),
    );
    expect(octokit.__calls.createComment).toHaveLength(0);
  });

  it('payload.action=labeled: returns early (no review), no callApi', async () => {
    const core = makeCore();
    const octokit = makeOctokit({ files: [file('src/a.js')] });
    const callApi = vi.fn(async () => JSON.stringify({ summary: 's', findings: [] }));
    const ctx = prContext();
    ctx.payload.action = 'labeled';

    await run(ctx, {
      config: makeConfig(),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
    });

    expect(callApi).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('Ignoring pull_request action: labeled'),
    );
  });

  it('payload.action=opened: proceeds with the review (allowed action)', async () => {
    const core = makeCore();
    const octokit = makeOctokit({ files: [file('src/a.js')] });
    const callApi = vi.fn(async () => JSON.stringify({ summary: 's', findings: [] }));
    const ctx = prContext();
    ctx.payload.action = 'opened';

    await run(ctx, {
      config: makeConfig(),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
    });

    expect(callApi).toHaveBeenCalledTimes(1);
  });

  it('payload.action=synchronize: proceeds with the review (allowed action)', async () => {
    const core = makeCore();
    const octokit = makeOctokit({ files: [file('src/a.js')] });
    const callApi = vi.fn(async () => JSON.stringify({ summary: 's', findings: [] }));
    const ctx = prContext();
    ctx.payload.action = 'synchronize';

    await run(ctx, {
      config: makeConfig(),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
    });

    expect(callApi).toHaveBeenCalledTimes(1);
  });

  // ----- W2-3: pull_request_target must be routed through the review pipeline,
  // not silently dropped. events.js (CFG-6) recognizes it as a PR event, but
  // index.js only checked `event === 'pull_request'`, so pull_request_target
  // events fell through to "Ignoring event" and were lost.
  it('eventName=pull_request_target: proceeds through the review pipeline (W2-3)', async () => {
    const core = makeCore();
    const octokit = makeOctokit({ files: [file('src/a.js')] });
    const callApi = vi.fn(async () => JSON.stringify({ summary: 's', findings: [] }));
    const ctx = {
      eventName: 'pull_request_target',
      repo: { owner: 'owner', repo: 'repo' },
      payload: {
        action: 'opened',
        pull_request: {
          number: 42,
          head: { repo: { fork: false }, sha: 'abc123' },
        },
      },
    };

    await run(ctx, {
      config: makeConfig(),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
    });

    // The review pipeline ran (callApi invoked once for the single batch).
    expect(callApi).toHaveBeenCalledTimes(1);
    // A comment was posted (the no-findings summary path).
    expect(octokit.__calls.createComment).toHaveLength(1);
    // And the event was NOT ignored.
    expect(core.info).not.toHaveBeenCalledWith(
      expect.stringContaining('Ignoring event: pull_request_target'),
    );
  });

  it('eventName=pull_request_target with action=closed: still respects the action allowlist', async () => {
    // The action allowlist applies equally to pull_request_target so a `closed`
    // event does not burn API credits on a re-review.
    const core = makeCore();
    const octokit = makeOctokit({ files: [file('src/a.js')] });
    const callApi = vi.fn(async () => JSON.stringify({ summary: 's', findings: [] }));
    const ctx = {
      eventName: 'pull_request_target',
      repo: { owner: 'owner', repo: 'repo' },
      payload: {
        action: 'closed',
        pull_request: {
          number: 42,
          head: { repo: { fork: false }, sha: 'abc123' },
        },
      },
    };

    await run(ctx, {
      config: makeConfig(),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
    });

    expect(callApi).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('Ignoring pull_request action: closed'),
    );
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

  /* ----------------------------------------------------------------
   * Phase 8.3: strict mode → REQUEST_CHANGES when critical/high present
   * ---------------------------------------------------------------- */

  it('strict mode OFF: high finding posts COMMENT (default advisory)', async () => {
    const core = makeCore();
    const octokit = makeOctokit({
      files: [{ filename: 'src/a.js', status: 'modified', patch: '@@ -1 +1 @@\n+const a = null;' }],
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
            title: 'Null deref',
            description: 'd',
            evidence: '',
            suggestion: null,
            rule: 'llm',
          },
        ],
      }),
    );

    await run(prContext(), {
      config: makeConfig({ strictMode: false }),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
    });

    expect(octokit.__calls.createReview).toHaveLength(1);
    // Default: advisory COMMENT even with a high finding (strict mode off).
    expect(octokit.__calls.createReview[0].event).toBe('COMMENT');
  });

  it('strict mode ON + high finding: posts REQUEST_CHANGES (blocks merge)', async () => {
    const core = makeCore();
    const octokit = makeOctokit({
      files: [{ filename: 'src/a.js', status: 'modified', patch: '@@ -1 +1 @@\n+const a = null;' }],
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
            title: 'Null deref',
            description: 'd',
            evidence: '',
            suggestion: null,
            rule: 'llm',
          },
        ],
      }),
    );

    await run(prContext(), {
      config: makeConfig({ strictMode: true }),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
    });

    expect(octokit.__calls.createReview).toHaveLength(1);
    expect(octokit.__calls.createReview[0].event).toBe('REQUEST_CHANGES');
  });

  it('strict mode ON + critical finding: posts REQUEST_CHANGES', async () => {
    const core = makeCore();
    const octokit = makeOctokit({
      files: [{ filename: 'src/a.js', status: 'modified', patch: '@@ -1 +1 @@\n+const a = null;' }],
    });
    const callApi = vi.fn(async () =>
      JSON.stringify({
        summary: 's',
        findings: [
          {
            file: 'src/a.js',
            line: 1,
            severity: 'critical',
            confidence: 'high',
            category: 'security',
            title: 'Secret leak',
            description: 'd',
            evidence: '',
            suggestion: null,
            rule: 'llm',
          },
        ],
      }),
    );

    await run(prContext(), {
      config: makeConfig({ strictMode: true }),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
    });

    expect(octokit.__calls.createReview).toHaveLength(1);
    expect(octokit.__calls.createReview[0].event).toBe('REQUEST_CHANGES');
  });

  it('strict mode ON + only medium/low findings: posts COMMENT (no escalation)', async () => {
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
            line: 1,
            severity: 'medium',
            confidence: 'medium',
            category: 'maintainability',
            title: 'Nit',
            description: 'd',
            evidence: '',
            suggestion: null,
            rule: 'llm',
          },
        ],
      }),
    );

    await run(prContext(), {
      config: makeConfig({ strictMode: true }),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
    });

    expect(octokit.__calls.createReview).toHaveLength(1);
    // Strict mode on, but no critical/high → stays advisory.
    expect(octokit.__calls.createReview[0].event).toBe('COMMENT');
  });
});

/* ------------------------------------------------------------------ *
 * Phase 8.1 — CODEOWNERS reviewer suggestions
 * ------------------------------------------------------------------ */

describe('run — pull_request CODEOWNERS reviewer suggestions (Phase 8.1)', () => {
  it('suggestReviewers OFF (default): no CODEOWNERS fetch, no suggestion line', async () => {
    const core = makeCore();
    const octokit = makeOctokit({
      files: [file('src/a.js')],
      codeownersContent: '* @alice\n',
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

    // No getContent call (CODEOWNERS not even fetched).
    expect(octokit.__calls.getContent).toHaveLength(0);
    const body = octokit.__calls.createComment[0].body;
    expect(body).not.toContain('Suggested reviewers');
    // No reviewer assignment.
    expect(octokit.__calls.requestReviewers).toHaveLength(0);
  });

  it('suggestReviewers ON: appends "Suggested reviewers" line to summary (read-only)', async () => {
    const core = makeCore();
    const octokit = makeOctokit({
      // README matches `*` only; src/a.js matches `src/**` (last-wins).
      files: [file('README.md'), file('src/a.js')],
      codeownersContent: '* @alice\nsrc/** @bob\n',
    });
    const callApi = vi.fn(async () =>
      JSON.stringify({ summary: 'Looks good.', findings: [] }),
    );

    await run(prContext(), {
      config: makeConfig({ suggestReviewers: true }),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
    });

    // CODEOWNERS was fetched from the head SHA. W5-6: precedence is
    // .github/CODEOWNERS first (matching GitHub's documented order).
    expect(octokit.__calls.getContent[0]).toMatchObject({
      path: '.github/CODEOWNERS',
    });
    // Suggestion line appears in the summary comment body, with BOTH owners
    // (README → @alice via `*`; src/a.js → @bob via `src/**` last-wins). The
    // comment body is run through the output sanitizer which breaks `@mentions`
    // with a zero-width space (@\u200b) to prevent notification spam, so we
    // match the owner logins via a regex that tolerates the separator.
    const body = octokit.__calls.createComment[0].body;
    expect(body).toContain('Suggested reviewers');
    expect(body).toMatch(/@\u200b?alice/);
    expect(body).toMatch(/@\u200b?bob/);
    // Read-only: no reviewer assignment.
    expect(octokit.__calls.requestReviewers).toHaveLength(0);
  });

  it('autoAssignReviewers ON: calls requestReviewers with @user logins (no @)', async () => {
    const core = makeCore();
    const octokit = makeOctokit({
      files: [file('src/a.js')],
      codeownersContent: 'src/** @alice @acme/team @bob\n',
    });
    const callApi = vi.fn(async () =>
      JSON.stringify({ summary: 's', findings: [] }),
    );

    await run(prContext(), {
      config: makeConfig({ autoAssignReviewers: true }),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
    });

    // requestReviewers called once, with bare user logins (no @, no team).
    expect(octokit.__calls.requestReviewers).toHaveLength(1);
    expect(octokit.__calls.requestReviewers[0]).toMatchObject({
      owner: 'owner',
      repo: 'repo',
      pull_number: 42,
    });
    expect(octokit.__calls.requestReviewers[0].reviewers.sort()).toEqual([
      'alice',
      'bob',
    ]);
    // The team still appears in the summary suggestion line (sanitizer breaks
    // the @mention with a zero-width space to prevent notification spam).
    const body = octokit.__calls.createComment[0].body;
    expect(body).toMatch(/@\u200b?acme\/team/);
  });

  it('autoAssignReviewers ON but no CODEOWNERS: no requestReviewers call (fail-soft)', async () => {
    const core = makeCore();
    const octokit = makeOctokit({
      files: [file('src/a.js')],
      codeownersContent: '', // 404 everywhere
    });
    const callApi = vi.fn(async () =>
      JSON.stringify({ summary: 's', findings: [] }),
    );

    await run(prContext(), {
      config: makeConfig({ autoAssignReviewers: true }),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
    });

    expect(octokit.__calls.requestReviewers).toHaveLength(0);
    // core.warning fired (no CODEOWNERS found).
    expect(core.warning).toHaveBeenCalled();
  });

  it('suggestReviewers ON but no changed files match CODEOWNERS: no suggestion line', async () => {
    const core = makeCore();
    const octokit = makeOctokit({
      files: [file('docs/readme.md')],
      codeownersContent: 'src/** @fe\n',
    });
    const callApi = vi.fn(async () =>
      JSON.stringify({ summary: 's', findings: [] }),
    );

    await run(prContext(), {
      config: makeConfig({ suggestReviewers: true }),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
    });

    const body = octokit.__calls.createComment[0].body;
    expect(body).not.toContain('Suggested reviewers');
  });

  it('suggestReviewers ON on the inline-review path: suggestion line in review body', async () => {
    const core = makeCore();
    const octokit = makeOctokit({
      files: [
        { filename: 'src/a.js', status: 'modified', patch: '@@ -1 +1 @@\n+const a = null;' },
      ],
      codeownersContent: 'src/** @alice\n',
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
      config: makeConfig({ suggestReviewers: true }),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
    });

    // Inline review path: createReview was called (not createComment).
    expect(octokit.__calls.createReview).toHaveLength(1);
    expect(octokit.__calls.createComment).toHaveLength(0);
    expect(octokit.__calls.createReview[0].body).toContain('Suggested reviewers');
    // The review body is sanitized (C1 fix): @mentions get a zero-width space
    // break so they can't spam notifications. Assert the sanitized form.
    expect(octokit.__calls.createReview[0].body).toMatch(/@\u200balice/);
  });

  it('suggestReviewers ON with a loadCodeowners injection override (bypasses fetch)', async () => {
    const core = makeCore();
    const octokit = makeOctokit({ files: [file('src/a.js')] });
    const callApi = vi.fn(async () =>
      JSON.stringify({ summary: 's', findings: [] }),
    );
    const fakeLoad = vi.fn(async () => [{ pattern: '*', owners: ['@injected'] }]);

    await run(prContext(), {
      config: makeConfig({ suggestReviewers: true }),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
      loadCodeowners: fakeLoad,
    });

    expect(fakeLoad).toHaveBeenCalledTimes(1);
    // No real getContent call (injection bypassed the octokit fetch).
    expect(octokit.__calls.getContent).toHaveLength(0);
    // The sanitizer breaks the @mention with a zero-width space.
    const body = octokit.__calls.createComment[0].body;
    expect(body).toMatch(/@\u200b?injected/);
  });

  it('requestReviewers failure never fails the review (fail-soft)', async () => {
    const core = makeCore();
    const octokit = makeOctokit({
      files: [file('src/a.js')],
      codeownersContent: 'src/** @alice\n',
    });
    // Override requestReviewers to throw.
    octokit.rest.pulls.requestReviewers = async () => {
      throw new Error('Reviews may only be requested by collaborators');
    };
    const callApi = vi.fn(async () =>
      JSON.stringify({ summary: 's', findings: [] }),
    );

    await run(prContext(), {
      config: makeConfig({ autoAssignReviewers: true }),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
    });

    // The review comment still posted (not failed) and a warning was logged.
    expect(octokit.__calls.createComment).toHaveLength(1);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('failed to request reviewers'),
    );
  });
});

/* ------------------------------------------------------------------ *
 * Phase 6.3 — incremental review (findings dedup across runs)
 * ------------------------------------------------------------------ */

describe('run — pull_request incremental review (Phase 6.3)', () => {
  it('appends the hash block to the inline review body when incrementalReview is on', async () => {
    const core = makeCore();
    const octokit = makeOctokit({
      files: [{ filename: 'src/a.js', status: 'modified', patch: '@@ -1 +1 @@\n+const a = null;' }],
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
            title: 'Null deref',
            description: 'a is null',
            evidence: '',
            suggestion: null,
            rule: 'llm',
          },
        ],
      }),
    );

    await run(prContext(), {
      config: makeConfig({ incrementalReview: true }),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
    });

    expect(octokit.__calls.createReview).toHaveLength(1);
    const body = octokit.__calls.createReview[0].body;
    // The MARKER is still present (idempotency detection unchanged).
    expect(body).toContain('<!-- zai-code-review -->');
    // The hash block is appended as a SEPARATE HTML comment.
    expect(body).toMatch(/<!-- zai-hashes:[0-9a-f,]+ -->/);
    // Both comments coexist in the same body.
    expect(body.indexOf('<!-- zai-code-review -->')).toBeLessThan(
      body.indexOf('<!-- zai-hashes:'),
    );
  });

  it('does NOT append the hash block when incrementalReview is off', async () => {
    const core = makeCore();
    const octokit = makeOctokit({
      files: [{ filename: 'src/a.js', status: 'modified', patch: '@@ -1 +1 @@\n+const a = null;' }],
    });
    const callApi = vi.fn(async () =>
      JSON.stringify({
        summary: 's',
        findings: [
          {
            file: 'src/a.js', line: 1, severity: 'high', confidence: 'medium',
            category: 'bug', title: 'X', description: 'd',
            evidence: '', suggestion: null, rule: 'llm',
          },
        ],
      }),
    );

    await run(prContext(), {
      config: makeConfig({ incrementalReview: false }),
      core, octokit, callApi, apiClient: { call: vi.fn() },
    });

    const body = octokit.__calls.createReview[0].body;
    expect(body).toContain('<!-- zai-code-review -->');
    expect(body).not.toMatch(/<!-- zai-hashes:/);
  });

  it('suppresses findings whose hash appears in the prior review body', async () => {
    const core = makeCore();
    // Build a prior review body whose hash block contains the EXACT hash of
    // the finding we're about to re-report. listBotReviews returns this body.
    const finding = {
      file: 'src/a.js', line: 1, severity: 'high', confidence: 'medium',
      category: 'bug', title: 'Dup', description: 'same',
      evidence: '', suggestion: null, rule: 'llm',
    };
    const priorHash = hashFinding(finding);
    const priorReview = {
      id: 999,
      body: `## Z.ai Code Review\n\nstale\n\n<!-- zai-code-review -->\n<!-- zai-hashes:${priorHash} -->`,
      user: { login: 'zai-code-review[bot]' },
    };
    const octokit = makeOctokit({
      files: [{ filename: 'src/a.js', status: 'modified', patch: '@@ -1 +1 @@\n+const a = null;' }],
      existingReviews: [priorReview],
    });
    // The model re-emits the SAME finding (same hash) plus a NEW one.
    const newFinding = { ...finding, title: 'Brand new', description: 'different' };
    const callApi = vi.fn(async () =>
      JSON.stringify({ summary: 's', findings: [finding, newFinding] }),
    );

    await run(prContext(), {
      config: makeConfig({ incrementalReview: true }),
      core, octokit, callApi, apiClient: { call: vi.fn() },
    });

    // Only the NEW finding's inline comment is posted.
    expect(octokit.__calls.createReview).toHaveLength(1);
    expect(octokit.__calls.createReview[0].comments).toHaveLength(1);
    expect(octokit.__calls.createReview[0].comments[0].body).toContain('Brand new');
    // The body carries a "previously-resolved" suppression note.
    const body = octokit.__calls.createReview[0].body;
    expect(body).toMatch(/1 previously-reported finding suppressed/);
    // The new hash block contains BOTH hashes (full set, not just kept).
    expect(body).toContain(priorHash);
    expect(body).toContain(hashFinding(newFinding));
  });

  it('keeps everything when prior review has no hash block (first run)', async () => {
    const core = makeCore();
    const priorReview = {
      id: 1,
      body: '## Z.ai Code Review\n\nold review without hashes\n\n<!-- zai-code-review -->',
      user: { login: 'zai-code-review[bot]' },
    };
    const octokit = makeOctokit({
      files: [{ filename: 'src/a.js', status: 'modified', patch: '@@ -1 +1 @@\n+const a = null;' }],
      existingReviews: [priorReview],
    });
    const callApi = vi.fn(async () =>
      JSON.stringify({
        summary: 's',
        findings: [
          {
            file: 'src/a.js', line: 1, severity: 'high', confidence: 'medium',
            category: 'bug', title: 'X', description: 'd',
            evidence: '', suggestion: null, rule: 'llm',
          },
        ],
      }),
    );

    await run(prContext(), {
      config: makeConfig({ incrementalReview: true }),
      core, octokit, callApi, apiClient: { call: vi.fn() },
    });

    // First run: nothing suppressed, finding posted.
    expect(octokit.__calls.createReview[0].comments).toHaveLength(1);
    expect(octokit.__calls.createReview[0].body).not.toMatch(/previously-reported/);
  });

  it('fall-soft: an incremental-read error is logged and the review still reaches the PR', async () => {
    const core = makeCore();
    const octokit = makeOctokit({
      files: [{ filename: 'src/a.js', status: 'modified', patch: '@@ -1 +1 @@\n+const a = null;' }],
    });
    // Make the FIRST listReviews call (the incremental read) throw, then
    // recover so upsertReview's own listBotReviews call succeeds. This models
    // a transient blip during the incremental phase without breaking the
    // dismiss-stale-then-post sequence.
    const realListReviews = octokit.rest.pulls.listReviews;
    let firstCall = true;
    octokit.rest.pulls.listReviews = async (params) => {
      if (firstCall) {
        firstCall = false;
        throw new Error('transient API down');
      }
      return realListReviews(params);
    };
    const callApi = vi.fn(async () =>
      JSON.stringify({
        summary: 's',
        findings: [
          {
            file: 'src/a.js', line: 1, severity: 'high', confidence: 'medium',
            category: 'bug', title: 'X', description: 'd',
            evidence: '', suggestion: null, rule: 'llm',
          },
        ],
      }),
    );

    await run(prContext(), {
      config: makeConfig({ incrementalReview: true }),
      core, octokit, callApi, apiClient: { call: vi.fn() },
    });

    // Warning logged about the incremental-read failure.
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringMatching(/Could not read prior reviews for incremental filter/),
    );
    // Review still posted with the finding (no suppression — priorHashes empty).
    expect(octokit.__calls.createReview).toHaveLength(1);
    expect(octokit.__calls.createReview[0].comments).toHaveLength(1);
  });

  // ------------------------------------------------------------------
  // W15-A8-3: incremental review read prior hashes ONLY from PR reviews
  // (listBotReviews). But when findings don't map to diff lines (file-level),
  // run 1 posts the hash block into the bot's marker ISSUE COMMENT (summary
  // path) — so on re-push priorHashes was empty and every finding was
  // re-reported despite documented suppression. The hash block must ALSO be
  // read from the bot's marker issue comment and merged with the review set.
  // ------------------------------------------------------------------
  it('W15-A8-3: suppresses findings whose hash appears in the bot marker ISSUE COMMENT (no prior review)', async () => {
    const core = makeCore();
    const finding = {
      file: 'src/a.js', line: 1, severity: 'high', confidence: 'medium',
      category: 'bug', title: 'Dup', description: 'same',
      evidence: '', suggestion: null, rule: 'llm',
    };
    const priorHash = hashFinding(finding);
    // NO prior reviews — run 1 posted the hash block on the marker ISSUE
    // COMMENT (the file-level/summary path), not on a review.
    const botComment = {
      id: 55,
      body:
        '## Z.ai Code Review\n\nprior summary\n\n<!-- zai-code-review -->\n' +
        `<!-- zai-hashes:${priorHash} -->`,
      user: { login: 'zai-code-review[bot]', type: 'Bot' },
    };
    const octokit = makeOctokit({
      files: [{ filename: 'src/a.js', status: 'modified', patch: '@@ -1 +1 @@\n+const a = null;' }],
      existingReviews: [],
      list: [botComment],
    });
    // The model re-emits the SAME finding plus a NEW one.
    const newFinding = { ...finding, title: 'Brand new', description: 'different' };
    const callApi = vi.fn(async () =>
      JSON.stringify({ summary: 's', findings: [finding, newFinding] }),
    );

    await run(prContext(), {
      config: makeConfig({ incrementalReview: true }),
      core, octokit, callApi, apiClient: { call: vi.fn() },
    });

    // Suppression happened (logged) and only the NEW finding is inline-posted.
    expect(core.info).toHaveBeenCalledWith(
      expect.stringMatching(/Incremental review: suppressed 1 previously-reported finding/),
    );
    expect(octokit.__calls.createReview).toHaveLength(1);
    expect(octokit.__calls.createReview[0].comments).toHaveLength(1);
    expect(octokit.__calls.createReview[0].comments[0].body).toContain('Brand new');
    const body = octokit.__calls.createReview[0].body;
    expect(body).toMatch(/1 previously-reported finding suppressed/);
  });

  it('W15-A8-3: a HUMAN comment carrying a forged hash block never suppresses (bot-authority gate)', async () => {
    const core = makeCore();
    const finding = {
      file: 'src/a.js', line: 1, severity: 'high', confidence: 'medium',
      category: 'bug', title: 'Dup', description: 'same',
      evidence: '', suggestion: null, rule: 'llm',
    };
    const humanComment = {
      id: 66,
      body:
        `quoted reply\n\n<!-- zai-code-review -->\n` +
        `<!-- zai-hashes:${hashFinding(finding)} -->`,
      user: { login: 'mallory', type: 'User' },
    };
    const octokit = makeOctokit({
      files: [{ filename: 'src/a.js', status: 'modified', patch: '@@ -1 +1 @@\n+const a = null;' }],
      existingReviews: [],
      list: [humanComment],
    });
    const callApi = vi.fn(async () =>
      JSON.stringify({ summary: 's', findings: [finding] }),
    );

    await run(prContext(), {
      config: makeConfig({ incrementalReview: true }),
      core, octokit, callApi, apiClient: { call: vi.fn() },
    });

    // No suppression: the finding is still posted inline.
    expect(octokit.__calls.createReview).toHaveLength(1);
    expect(octokit.__calls.createReview[0].comments).toHaveLength(1);
    expect(octokit.__calls.createReview[0].body).not.toMatch(/previously-reported/);
  });

  // ------------------------------------------------------------------
  // W16-B2-3: the marker-comment hash read used findBotMarkerComment (FIRST
  // bot marker comment only). When a fallback comment exists — created after
  // an inline-review failure, and the fallback path always CREATES a new
  // comment — its hash block (the newest full set) was never read, so hashes
  // only present there were orphaned and their findings re-reported on
  // re-push. The read must UNION parseFindingsHashBlock across ALL bot
  // marker comments (same bot-authority gating + pagination).
  // ------------------------------------------------------------------
  it('W16-B2-3: unions hash blocks across ALL bot marker comments (C1[h1], C2[h1,h2] → both suppressed)', async () => {
    const core = makeCore();
    const finding1 = {
      file: 'src/a.js', line: 1, severity: 'high', confidence: 'medium',
      category: 'bug', title: 'Dup one', description: 'same',
      evidence: '', suggestion: null, rule: 'llm',
    };
    const finding2 = {
      file: 'src/a.js', line: 2, severity: 'high', confidence: 'medium',
      category: 'bug', title: 'Dup two', description: 'same',
      evidence: '', suggestion: null, rule: 'llm',
    };
    const h1 = hashFinding(finding1);
    const h2 = hashFinding(finding2);
    // C1: the original marker comment (only h1 was known when it was posted).
    // C2: the fallback comment created after an inline-review failure — it
    // carries the newest FULL set. listReviews is EMPTY (nothing inline).
    const c1 = {
      id: 101,
      body: `## Z.ai Code Review\n\nfirst summary\n\n<!-- zai-code-review -->\n<!-- zai-hashes:${h1} -->`,
      user: { login: 'zai-code-review[bot]', type: 'Bot' },
    };
    const c2 = {
      id: 102,
      body: `fallback summary\n\n<!-- zai-code-review -->\n<!-- zai-hashes:${h1},${h2} -->`,
      user: { login: 'zai-code-review[bot]', type: 'Bot' },
    };
    const octokit = makeOctokit({
      files: [{ filename: 'src/a.js', status: 'modified', patch: '@@ -1,2 +1,2 @@\n+const a = null;\n+const b = null;' }],
      existingReviews: [],
      list: [c1, c2],
    });
    // The model re-emits BOTH previously-reported findings.
    const callApi = vi.fn(async () =>
      JSON.stringify({ summary: 's', findings: [finding1, finding2] }),
    );

    await run(prContext(), {
      config: makeConfig({ incrementalReview: true }),
      core, octokit, callApi, apiClient: { call: vi.fn() },
    });

    // h2 lived ONLY in C2 — with the first-match read it was orphaned and
    // finding2 re-reported. The union read suppresses BOTH.
    expect(core.info).toHaveBeenCalledWith(
      expect.stringMatching(/Incremental review: suppressed 2 previously-reported finding/),
    );
    // No inline findings survived → no review with comments was posted.
    expect(octokit.__calls.createReview).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * W17-C1-3 — skipped-files note (cumulative MAX_DIFF_CHARS cap)
 *
 * W16-B3-4 recorded metadata.skippedFiles/skippedEntries but NOTHING
 * consumed them: with a small maxDiffChars the bot silently dropped files
 * and still posted a bare "No issues found. The changes look good. ✅".
 * The run must surface the drop in the posted body (both the summary
 * comment path via formatFindingsAsSummary and the inline-review path via
 * buildReviewBody), mirroring the italic truncated-note style.
 * ------------------------------------------------------------------ */

describe('run — pull_request skipped-files note (W17-C1-3)', () => {
  it('W17-C1-3: real pipeline, 2 files + maxDiffChars 5 → summary body carries the skip note next to the all-clear', async () => {
    const core = makeCore();
    const octokit = makeOctokit({
      files: [file('src/a.js'), file('src/b.js')],
    });
    const callApi = vi.fn(async () =>
      JSON.stringify({ summary: '', findings: [] }),
    );

    await run(prContext(), {
      config: makeConfig({ maxDiffChars: 5 }),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
    });

    // maxDiffChars 5 < every packed entry → 0 batches, 0 model calls, and
    // both files recorded as skipped by the (real) structured pipeline.
    expect(callApi).not.toHaveBeenCalled();
    expect(octokit.__calls.createComment).toHaveLength(1);
    const body = octokit.__calls.createComment[0].body;
    // The all-clear line is still there…
    expect(body).toContain('No issues found');
    // …but it is NOT bare: the skip note is rendered in the same body.
    expect(body).toContain('2 files not reviewed (MAX_DIFF_CHARS cap).');
  });

  it('W17-C1-3: inline review body carries the skip note (buildReviewBody path) and threads skippedFiles into its metadata', async () => {
    const core = makeCore();
    const octokit = makeOctokit({
      files: [file('src/a.js', '@@ -1,0 +2 @@\n+const x = 1;\n')],
    });
    const runStructuredReviewSpy = vi.fn(async () => ({
      findings: [
        { file: 'src/a.js', line: 2, severity: 'high', title: 'T', description: 'd' },
      ],
      summary: 's',
      metadata: {
        totalBatches: 1,
        totalFindingsBeforeCap: 1,
        deterministicFindingsCount: 0,
        batchMetadata: [],
        skippedFiles: 1,
        skippedEntries: 3,
      },
    }));

    await run(prContext(), {
      config: makeConfig(),
      core,
      octokit,
      callApi: vi.fn(),
      apiClient: { call: vi.fn() },
      runStructuredReview: runStructuredReviewSpy,
    });

    expect(octokit.__calls.createReview).toHaveLength(1);
    const body = octokit.__calls.createReview[0].body;
    expect(body).toContain('1 file not reviewed (MAX_DIFF_CHARS cap).');
  });

  it('W17-C1-3: zero skipped files → no skip note in the summary body', async () => {
    const core = makeCore();
    const octokit = makeOctokit({ files: [file('src/a.js')] });
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

    expect(octokit.__calls.createComment).toHaveLength(1);
    const body = octokit.__calls.createComment[0].body;
    expect(body).toContain('No issues found');
    expect(body).not.toContain('not reviewed');
    expect(body).not.toContain('MAX_DIFF_CHARS');
  });
});

/* ------------------------------------------------------------------ *
 * W18-D2-3 — partial-drop portion note (skippedEntries)
 *
 * skippedFiles counts only zero-entry files, but skippedEntries (partial
 * drops of multi-chunk files) was surfaced NOWHERE: a file with 2/15 chunks
 * reviewed posted a bare "No issues found ✅". When files were partially
 * dropped (skippedEntries > 0 && skippedFiles === 0), the body must carry a
 * portion note in the same italic style; when both kinds fired, both notes.
 * ------------------------------------------------------------------ */

describe('run — pull_request partial-drop portion note (W18-D2-3)', () => {
  it('W18-D2-3: partial drops only (skippedFiles 0, skippedEntries 13) → summary body carries the portion note, not the file note', async () => {
    const core = makeCore();
    const octokit = makeOctokit({ files: [file('src/a.js')] });
    const runStructuredReviewSpy = vi.fn(async () => ({
      findings: [],
      summary: '',
      metadata: {
        totalBatches: 1,
        totalFindingsBeforeCap: 0,
        deterministicFindingsCount: 0,
        batchMetadata: [],
        skippedFiles: 0,
        skippedEntries: 13,
      },
    }));

    await run(prContext(), {
      config: makeConfig(),
      core,
      octokit,
      callApi: vi.fn(),
      apiClient: { call: vi.fn() },
      runStructuredReview: runStructuredReviewSpy,
    });

    expect(octokit.__calls.createComment).toHaveLength(1);
    const body = octokit.__calls.createComment[0].body;
    // The all-clear is NOT bare: the portion note is rendered next to it.
    expect(body).toContain('No issues found');
    expect(body).toContain('13 portions not reviewed (MAX_DIFF_CHARS cap).');
    // No file was skipped wholesale → no file note.
    expect(body).not.toContain('files not reviewed');
  });

  it('W18-D2-3: both full-file and partial drops → BOTH notes render in the inline review body', async () => {
    const core = makeCore();
    const octokit = makeOctokit({
      files: [file('src/a.js', '@@ -1,0 +2 @@\n+const x = 1;\n')],
    });
    const runStructuredReviewSpy = vi.fn(async () => ({
      findings: [
        { file: 'src/a.js', line: 2, severity: 'high', title: 'T', description: 'd' },
      ],
      summary: 's',
      metadata: {
        totalBatches: 1,
        totalFindingsBeforeCap: 1,
        deterministicFindingsCount: 0,
        batchMetadata: [],
        skippedFiles: 1,
        skippedEntries: 13,
      },
    }));

    await run(prContext(), {
      config: makeConfig(),
      core,
      octokit,
      callApi: vi.fn(),
      apiClient: { call: vi.fn() },
      runStructuredReview: runStructuredReviewSpy,
    });

    expect(octokit.__calls.createReview).toHaveLength(1);
    const body = octokit.__calls.createReview[0].body;
    // The existing W17-C1-3 file note is unchanged…
    expect(body).toContain('1 file not reviewed (MAX_DIFF_CHARS cap).');
    // …and the partial-drop portion note rides alongside it.
    expect(body).toContain('13 portions not reviewed (MAX_DIFF_CHARS cap).');
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

  it('fork gate: getPRContext returning null fails CLOSED (treats as fork, blocks)', async () => {
    // When getPRContext resolves to null (not throws), the fork resolver must
    // NOT default to isFork=false (fail open). It must fail closed so a broken
    // PR lookup cannot let a fork command through the gate.
    const core = makeCore();
    const octokit = makeOctokit();
    const handler = vi.fn();

    await run(
      commentContext({
        body: '/zai ask hi',
        association: 'COLLABORATOR',
        login: 'alice',
      }),
      {
        // allowForkCommands defaults to false → fork gate is active.
        config: makeConfig(),
        core,
        octokit,
        callApi: vi.fn(),
        apiClient: { call: vi.fn() },
        handlers: { ask: handler },
        getPRContext: vi.fn(async () => null), // resolves null, does NOT throw
      },
    );

    // Fail-closed: the command from a (presumed) fork must be blocked.
    expect(handler).not.toHaveBeenCalled();
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

  // W18-D1-2: the scheduled incremental read must ALSO read prior hashes from
  // bot REVIEWS (the inline path deposits its hash block there). The schedule
  // branch wires the real review.js listBotReviews — pin the wiring.
  it('schedule: enabled → threads listBotReviews (W18-D1-2 review-side prior-hash reads)', async () => {
    const core = makeCore();
    const octokit = makeOctokit();
    const callApi = vi.fn(async () => 'review');
    const runScheduledReview = vi.fn(async () => ({ reviewed: 0, skipped: 0, failed: 0 }));
    const listBotReviews = vi.fn(async () => []);

    await run(
      { eventName: 'schedule', repo: { owner: 'o', repo: 'r' }, payload: {} },
      {
        config: makeConfig({ scheduleEnabled: true }),
        core,
        octokit,
        callApi,
        apiClient: { call: vi.fn() },
        runScheduledReview,
        listBotReviews,
      },
    );

    expect(runScheduledReview).toHaveBeenCalledTimes(1);
    expect(runScheduledReview.mock.calls[0][0].listBotReviews).toBe(listBotReviews);
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

  // ------------------------------------------------------------------
  // W15-A6-2: the success commit status was computed from result.findings
  // BEFORE the incremental-suppression and learnings-suppression stages ran.
  // A re-push where every finding was already reported (hash block covers
  // them all) posted "Review complete: 2 findings (...)" to the checks tab
  // while the PR comment said "No issues found ✅" — contradictory signals.
  // The success status must reflect the FINAL kept-findings set.
  // ------------------------------------------------------------------
  it('W15-A6-2: success status reflects POST-suppression findings (all suppressed → "no issues found")', async () => {
    const core = makeCore();
    const finding = {
      file: 'src/a.js', line: 1, severity: 'critical', confidence: 'high',
      category: 'bug', title: 'Dup', description: 'same',
      evidence: '', suggestion: null, rule: 'llm',
    };
    const finding2 = {
      file: 'src/a.js', line: 2, severity: 'high', confidence: 'high',
      category: 'bug', title: 'Dup2', description: 'same2',
      evidence: '', suggestion: null, rule: 'llm',
    };
    const priorReview = {
      id: 999,
      body:
        '## Z.ai Code Review\n\nstale\n\n<!-- zai-code-review -->\n' +
        `<!-- zai-hashes:${hashFinding(finding)},${hashFinding(finding2)} -->`,
      user: { login: 'zai-code-review[bot]' },
    };
    const octokit = makeOctokit({
      files: [{ filename: 'src/a.js', status: 'modified', patch: '@@ -1,2 +1,2 @@\n+const a = null;\n+const b = null;' }],
      existingReviews: [priorReview],
    });
    // The model re-emits BOTH findings (unchanged → both suppressed).
    const callApi = vi.fn(async () =>
      JSON.stringify({ summary: 's', findings: [finding, finding2] }),
    );

    await run(prContext({ sha: 'sha-inc' }), {
      config: makeConfig({ commitStatus: true, incrementalReview: true }),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
    });

    const statuses = octokit.__calls.createCommitStatus;
    expect(statuses.length).toBeGreaterThanOrEqual(2);
    expect(statuses[0].state).toBe('pending');
    const success = statuses[statuses.length - 1];
    expect(success.state).toBe('success');
    // 0 kept findings → the "no issues" form, NOT "2 findings (...)".
    expect(success.description).toContain('no issues found');
    expect(success.description).not.toContain('2 findings');
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

  // ------------------------------------------------------------------
  // W15-A7-3: the PR path posts the `pending` commit status, then the early
  // return "All patchable files excluded by .zai.yml path_filters; skipping."
  // returned WITHOUT a terminal status — the check spun pending forever and
  // blocked merges when the status is required. The early return must post a
  // terminal `success` status (there is genuinely nothing to review).
  // ------------------------------------------------------------------
  it('W15-A7-3: posts a terminal success status when .zai.yml path_filters exclude all files', async () => {
    const core = makeCore();
    const octokit = makeOctokit({
      files: [file('src/a.js'), file('docs/readme.md')],
    });
    const callApi = vi.fn(async () => 'should not run');
    // Inject a merged repo config whose path_filters exclude every changed file.
    const mergeRepoConfigSpy = vi.fn(() => ({
      excludePatterns: ['src/**', 'docs/**'],
      maxFindings: 8,
    }));

    await run(prContext({ sha: 'sha-excl' }), {
      config: makeConfig({ commitStatus: true, repoConfigEnabled: true }),
      core,
      octokit,
      callApi,
      apiClient: { call: vi.fn() },
      mergeRepoConfig: mergeRepoConfigSpy,
      loadRepoConfig: vi.fn(async () => ({})),
    });

    // The last status must be TERMINAL (success), not the forever-pending one.
    const statuses = octokit.__calls.createCommitStatus;
    expect(statuses.length).toBeGreaterThanOrEqual(2);
    expect(statuses[0].state).toBe('pending');
    const last = statuses[statuses.length - 1];
    expect(last.state).toBe('success');
    expect(last.state).not.toBe('pending');
    expect(last.sha).toBe('sha-excl');
    expect(last.description).toMatch(/no reviewable files/i);
    // And the review really was skipped.
    expect(callApi).not.toHaveBeenCalled();
    expect(octokit.__calls.createReview).toHaveLength(0);
    expect(octokit.__calls.createComment).toHaveLength(0);
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('All patchable files excluded by .zai.yml path_filters'),
    );
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

/* ------------------------------------------------------------------ *
 * createScannerDeps — production scanner-dep factory (blocker-task-1)
 *
 * This is the wiring that lets the deterministic scanners actually invoke
 * gitleaks / ast-grep in production (downloading + verifying + extracting
 * on first use, then caching). The shape contract: every property must be a
 * function (so `runScanners` forwards it and the scanners take the binary
 * path instead of falling back to regex).
 * ------------------------------------------------------------------ */

describe('createScannerDeps', () => {
  it('returns an object with function values for every expected key', () => {
    const deps = createScannerDeps({ core: { info: () => {} }, cacheDir: '/tmp/x' });
    expect(deps).toBeTruthy();
    // Every one of these MUST be a function — if any is undefined, the
    // scanners fall back to regex and the binary path is dead.
    expect(typeof deps.ensureBinary).toBe('function');
    expect(typeof deps.runBinary).toBe('function');
    expect(typeof deps.runCommand).toBe('function');
    expect(typeof deps.scanSecrets).toBe('function');
    expect(typeof deps.scanPatterns).toBe('function');
    expect(typeof deps.computeMetrics).toBe('function');
  });

  it('passes `core` through unchanged', () => {
    const core = { info: vi.fn(), warning: vi.fn() };
    const deps = createScannerDeps({ core, cacheDir: '/tmp/x' });
    expect(deps.core).toBe(core);
  });

  it('ensureBinary wires real fetch/writeFile/stat/mkdir/chmod (functions, not undefined)', async () => {
    const deps = createScannerDeps({ core: {}, cacheDir: '/tmp/x' });
    // Drive ensureBinary with a spec that hits the cache-miss path. We inject
    // fakes via the second arg (the inner-deps merge), proving the production
    // wrapper accepts overrides AND supplies defaults for everything not
    // overridden. The injected fetch returns bytes whose SHA matches the spec
    // checksum, so the happy path runs to completion.
    const { sha256Hex } = await import('../src/lib/scanners/ensure-binary.js');
    const bytes = Buffer.from('hello\n');
    const checksum = sha256Hex(bytes);
    const fakeFetch = vi.fn(async () => bytes);
    const fakeWriteFile = vi.fn(async () => {});
    const fakeStat = vi.fn(async () => {
      throw new Error('ENOENT');
    });
    const fakeChmod = vi.fn(async () => {});
    const path = await deps.ensureBinary(
      {
        name: 'gitleaks',
        version: '8.21.2',
        url: 'https://example.com/gitleaks.tar.gz',
        checksumSha256: checksum,
        cacheDir: '/cache',
      },
      {
        fetch: fakeFetch,
        writeFile: fakeWriteFile,
        stat: fakeStat,
        chmod: fakeChmod,
      },
    );
    expect(path.endsWith('/gitleaks/8.21.2/gitleaks')).toBe(true);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(fakeWriteFile).toHaveBeenCalledTimes(1);
    expect(fakeChmod).toHaveBeenCalledTimes(1);
  });

  it('runBinary returns { stdout, stderr }-shaped result (execFile promisify contract)', async () => {
    const deps = createScannerDeps({ core: {}, cacheDir: '/tmp/x' });
    // Echo is universally available on every test runner. Run it via runBinary
    // to verify the function actually delegates to execFile (not undefined).
    const result = await deps.runBinary('echo', ['hello']);
    expect(typeof result).toBe('object');
    expect(String(result.stdout).trim()).toBe('hello');
  });
});

/* ------------------------------------------------------------------ *
 * httpsGet — production fetch wrapper
 * ------------------------------------------------------------------ */

describe('httpsGet', () => {
  it('is a function', () => {
    expect(typeof httpsGet).toBe('function');
  });

  it('rejects on empty / non-string url', async () => {
    await expect(httpsGet('')).rejects.toThrow(/url is required/);
  });

  it('rejects non-https URLs (defense-in-depth)', async () => {
    await expect(httpsGet('http://example.com/file')).rejects.toThrow(/non-https/);
  });

  it('rejects untrusted redirect hosts by default (W3S-03)', async () => {
    await expect(httpsGet('https://evil.example.com/file')).rejects.toThrow(/untrusted host/);
  });

  it('rejects invalid URLs cleanly', async () => {
    await expect(httpsGet('not-a-url')).rejects.toThrow(/invalid url/);
  });
});
