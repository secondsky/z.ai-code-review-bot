/**
 * GitHub Action entry point + event router.
 *
 * This module WIRES TOGETHER every lib module: events, config, api, auth,
 * comments, changed-files, prompt, auto-review, and the parser in commands.
 * It is what `@vercel/ncc` bundles to `dist/index.js` and what the action
 * runner executes.
 *
 * IMPORT SAFETY:
 *   The module MUST be importable by tests WITHOUT triggering `main()`. The
 *   top-level auto-run is guarded by `isMainEntry()`, which compares the
 *   resolved path of `import.meta.url` against `process.argv[1]` (the entry
 *   the runner invoked). Under the vitest runner `process.argv[1]` is the
 *   vitest binary, so `isMainEntry()` returns false and `main()` is never
 *   called on import. Under the bundled action (CJS), ncc preserves the
 *   entry semantics and `process.argv[1]` is `dist/index.js`, so the guard
 *   fires and `main()` runs.
 *
 * INJECTION:
 *   `run(context, deps)` accepts overrides for every external collaborator
 *   (octokit, core, callApi, apiClient, handlers, and the module helpers). In
 *   production the helpers default to the real lib functions; in tests every
 *   collaborator is faked so no network/GitHub is touched.
 *
 * ERROR HANDLING:
 *   `run` lets errors propagate (tests can assert). `main` catches and calls
 *   `core.setFailed(err.message)`. Nothing is swallowed.
 */

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as https from 'node:https';

import core from '@actions/core';
import github from '@actions/github';

import {
  eventName,
  getPullNumber,
  isForkPullRequest,
  getCommenter,
  isBotComment,
} from './lib/events.js';
import { loadConfig } from './lib/config.js';
import { createApiClient } from './lib/api.js';
import { authorize } from './lib/auth.js';
import { upsertReviewComment, buildCommentBody, appendTrailers, MARKER } from './lib/comments.js';
import {
  getChangedFiles,
  filterExcludedFiles,
  filterPatchableFiles,
} from './lib/changed-files.js';
import { resolveSystemPrompt } from './lib/prompt.js';
import { runStructuredReview, isLargePr } from './lib/auto-review.js';
import {
  formatFindingsAsSummary,
  hashFinding,
  buildFindingsHashBlock,
  parseFindingsHashBlock,
  filterIncrementalFindings,
} from './lib/findings.js';
import { formatWalkthroughSummary } from './lib/walkthrough.js';
import { partitionFindings } from './lib/diff.js';
import {
  buildReviewBody,
  buildReviewComments,
  resolveReviewEvent,
  upsertReview,
  listBotReviews,
  postFallbackComment,
} from './lib/review.js';
import { parseCommand } from './lib/commands.js';
import { HANDLERS } from './lib/handlers/index.js';
import { getPRContext } from './lib/handlers/_shared.js';
import { runScheduledReview, buildShaBlock } from './lib/schedule.js';
import { runScanners, formatScannerContext } from './lib/scanners/index.js';
import { ensureBinary } from './lib/scanners/ensure-binary.js';
import { scanSecrets } from './lib/scanners/secrets.js';
import { scanPatterns } from './lib/scanners/patterns.js';
import { computeMetrics } from './lib/scanners/metrics.js';
import { setReviewStatus, buildStatusDescription } from './lib/status.js';
import { loadRepoConfig, mergeRepoConfig } from './lib/repo-config.js';
import {
  loadCodeowners,
  suggestReviewers,
  formatSuggestedReviewersLine,
  pickAssignableReviewers,
} from './lib/codeowners.js';
import {
  loadLearnings,
  filterFindingsByLearnings,
  formatLearningsForPrompt,
} from './lib/learnings.js';

/* ------------------------------------------------------------------ *
 * Entry-point guard
 * ------------------------------------------------------------------ */

/**
 * True only when this module is the process entry point (i.e. the action
 * runner invoked `dist/index.js` directly), NOT when it is imported (e.g. by
 * tests). This keeps the module import-safe.
 *
 * Implementation: resolve `import.meta.url` to a filesystem path and compare
 * against `process.argv[1]` (the file Node was asked to run). The comparison
 * is path-based so it works for both ESM source (under vitest) and ncc's CJS
 * bundle (which preserves `process.argv[1] === dist/index.js`).
 *
 * @returns {boolean}
 */
export function isMainEntry() {
  try {
    if (!process.argv[1]) return false;
    const here = resolve(fileURLToPath(import.meta.url));
    const entry = resolve(process.argv[1]);
    return here === entry;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * readAllInputs
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Expand a leading `~` to the user's home directory. Returns the input
 * unchanged for non-tilde paths or non-strings. Used to resolve the
 * ZAI_SCANNERS_CACHE_DIR default (`~/.zai-cache/scanners`) at runtime.
 *
 * @param {string} p
 * @returns {string}
 */
export function expandHome(p) {
  if (typeof p !== 'string' || p.length === 0) return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return `${homedir()}${p.slice(1)}`;
  return p;
}

/**
 * Promisified `execFile` from `node:child_process`. Module-level binding so we
 * don't pay the promisify cost per call and so tests can stub it via the
 * scanner deps seam.
 */
const execFileAsync = promisify(execFileCb);

/**
 * Minimal `https.get` wrapper that resolves to a Buffer of the response body.
 * Follows up to 5 redirects (GitHub release assets redirect to a CDN). Rejects
 * on any network/HTTP error. Used as `deps.fetch` for `ensureBinary`.
 *
 * Zero new dependencies: uses only `node:https`. Equivalent to fetch() but
 * works on Node 18 (where global fetch is behind a flag in some builds) and
 * returns a Buffer directly (no `Response.arrayBuffer()` dance).
 *
 * @param {string} url
 * @param {{ maxRedirects?: number }} [opts]
 * @returns {Promise<Buffer>}
 */
export function httpsGet(url, opts = {}) {
  const maxRedirects = typeof opts.maxRedirects === 'number' ? opts.maxRedirects : 5;
  // Defense-in-depth: cap download size (scanner binaries are <50 MB) to
  // prevent memory exhaustion from a compromised/malicious CDN response.
  const maxSize = typeof opts.maxSize === 'number' && opts.maxSize > 0 ? opts.maxSize : 100 * 1024 * 1024;
  // Defense-in-depth: restrict redirect hosts to known GitHub asset domains so
  // a compromised redirect cannot SSRF internal endpoints on self-hosted runners.
  const allowedHosts =
    Array.isArray(opts.allowedHosts) && opts.allowedHosts.length > 0
      ? opts.allowedHosts
      : ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'codeload.github.com'];
  return new Promise((resolve, reject) => {
    if (typeof url !== 'string' || url.length === 0) {
      reject(new Error('httpsGet: url is required'));
      return;
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`httpsGet: invalid url (${url})`));
      return;
    }
    if (parsed.protocol !== 'https:') {
      reject(new Error(`httpsGet: refusing non-https url (${url})`));
      return;
    }
    if (!allowedHosts.includes(parsed.hostname)) {
      reject(new Error(`httpsGet: refusing redirect to untrusted host (${parsed.hostname})`));
      return;
    }
    const req = https.get(url, (res) => {
      const status = res.statusCode || 0;
      // Redirect: follow the Location header.
      if (status >= 300 && status < 400 && res.headers.location) {
        if (maxRedirects <= 0) {
          reject(new Error(`httpsGet: too many redirects (${url})`));
          res.resume();
          return;
        }
        // Resolve relative redirects against the current URL.
        const nextUrl = new URL(res.headers.location, url).toString();
        res.resume(); // free the body
        resolve(httpsGet(nextUrl, { maxRedirects: maxRedirects - 1, maxSize, allowedHosts }));
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        reject(new Error(`httpsGet: HTTP ${status} for ${url}`));
        return;
      }
      /** @type {Buffer[]} */
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > maxSize) {
          req.destroy(new Error(`httpsGet: response exceeded size limit (${maxSize} bytes)`));
          return;
        }
        chunks.push(buf);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    // Belt-and-braces timeout so a hung connection can't wedge the action.
    // 60s should be plenty for any GitHub release asset (≤ 50MB).
    req.setTimeout(60_000, () => {
      req.destroy(new Error('httpsGet: request timed out (60s)'));
    });
  });
}

/**
 * Build the production scanner-dependency kit. Returns the deps object that
 * `runScanners` forwards to `scanSecrets` / `scanPatterns`. Each dep is a real
 * Node builtin; tests inject fakes via `deps.runScanners` / `deps.scanSecrets`
 * overrides higher up.
 *
 * Deps produced:
 *   - `core`           — passed through (the @actions/core kit).
 *   - `ensureBinary`   — wraps the real `ensureBinary` from
 *                         `./lib/scanners/ensure-binary.js`, injecting real
 *                         `fetch` (httpsGet), `writeFile`, `stat`, `mkdir`,
 *                         `chmod`. Used by both scanners.
 *   - `runBinary`      — `promisify(execFile)` with a 10MB maxBuffer (used by
 *                         both scanners; the brief specifies this exact size).
 *   - `runCommand`     — `promisify(execFile)` without maxBuffer cap (used by
 *                         the archive extractors to invoke system `tar`).
 *   - `scanSecrets`    — the real implementation (so `runScanners` doesn't
 *                         fall through to its no-binary default).
 *   - `scanPatterns`   — the real implementation.
 *   - `computeMetrics` — the real implementation.
 *
 * The brief specified `runBinary(cmd, args)` and `runCommand(cmd, args)`
 * signatures; we preserve that (callers use positional args).
 *
 * @param {{ core?: object, cacheDir?: string }} [args]
 * @returns {Object}
 */
export function createScannerDeps({ core: coreArg, cacheDir } = {}) {
  return {
    core: coreArg,
    ensureBinary: (spec, innerDeps = {}) =>
      ensureBinary(spec, {
        fetch: httpsGet,
        writeFile: (p, b) => fs.writeFile(p, b),
        stat: (p) => fs.stat(p),
        mkdir: (p) => fs.mkdir(p, { recursive: true }),
        chmod: (p, m) => fs.chmod(p, m),
        ...innerDeps,
      }),
    runBinary: (cmd, args, opts) =>
      execFileAsync(cmd, args, {
        maxBuffer: 10 * 1024 * 1024,
        ...(opts || {}),
      }),
    runCommand: (cmd, args, opts) => execFileAsync(cmd, args, opts || {}),
    scanSecrets,
    scanPatterns,
    computeMetrics,
  };
}

/**
 * The complete list of action input names, in the order loadConfig reads them.
 * Exported so the test can assert coverage. Keep in sync with config.js.
 */
export const INPUT_NAMES = [
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
  'ZAI_BATCH_CONCURRENCY',
  'ZAI_FALLBACK_PROMPT',
  'ZAI_SCANNERS_ENABLED',
  'ZAI_SCANNERS_CACHE_DIR',
  'ZAI_COMMIT_STATUS',
  'ZAI_WALKTHROUGH',
  'ZAI_INCREMENTAL_REVIEW',
  'ZAI_REPO_CONFIG_ENABLED',
  'ZAI_STRICT_MODE',
  'ZAI_SUGGEST_REVIEWERS',
  'ZAI_AUTO_ASSIGN_REVIEWERS',
  'ZAI_LEARNINGS_ENABLED',
  'GITHUB_TOKEN',
];

/**
 * Build the fallback comment body used when inline review submission fails.
 *
 * Carries the review summary (already built, marker included) plus every
 * finding rendered as plain text so the structured review still reaches the PR
 * even if the review API rejected the payload. The findings are appended after
 * a clear "Review could not be posted inline" preamble.
 *
 * @param {string} reviewBody  The review body (already includes the marker).
 * @param {Array} findings     All findings (inline + summary-only).
 * @param {string} reviewerName
 * @returns {string}
 */
function buildFallbackBody(reviewBody, findings, reviewerName) {
  const list = Array.isArray(findings) ? findings : [];
  const parts = [
    `_⚠️ ${reviewerName || 'Z.ai Code Review'} could not be posted as an inline review; falling back to a summary comment._`,
    '',
    reviewBody,
  ];
  if (list.length > 0) {
    parts.push('', '### Findings');
    for (const f of list) {
      const file = typeof f?.file === 'string' ? f.file : '';
      const line = typeof f?.line === 'number' && f.line > 0 ? `:L${f.line}` : '';
      const title = typeof f?.title === 'string' ? f.title : '';
      parts.push(`- **${file}${line}** — ${title}`);
    }
  }
  return parts.join('\n');
}

/**
 * Append the Phase 6.3 incremental-suppression note to the model's summary.
 *
 * The note is appended (with a blank-line separator) so reviewers can see how
 * many previously-resolved findings were elided. Returns the (possibly empty)
 * summary with the note appended. Kept as a pure helper so it can be unit
 * tested in isolation if needed.
 *
 * INT-11: also surfaces learnings-suppressed findings (Phase 8.2). Previously
 * only the incremental count was reported, so a run that suppressed 5 findings
 * via learnings showed no note at all — reviewers had no signal that the bot
 * had intentionally dropped findings. Both suppression reasons now contribute
 * to a single note so the summary reflects the total elided count.
 *
 * @param {string} summary  The model's original summary prose.
 * @param {number} suppressedCount  How many findings were suppressed (incremental).
 * @param {number} [learningsSuppressed]  How many findings were suppressed by learnings.
 * @returns {string}
 */
function appendIncrementalNote(summary, suppressedCount, learningsSuppressed = 0) {
  const base = typeof summary === 'string' ? summary : '';
  const inc = typeof suppressedCount === 'number' && suppressedCount > 0 ? suppressedCount : 0;
  const lrn = typeof learningsSuppressed === 'number' && learningsSuppressed > 0 ? learningsSuppressed : 0;
  const total = inc + lrn;
  if (total === 0) return base;
  // Compose a note that reflects BOTH suppression reasons when both fired.
  const parts = [];
  if (inc > 0) {
    parts.push(`${inc} previously-reported finding${inc === 1 ? '' : 's'}`);
  }
  if (lrn > 0) {
    parts.push(`${lrn} previously-accepted learning${lrn === 1 ? '' : 's'}`);
  }
  // English join: "a and b" or just "a".
  const what = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  const note = `_${what} suppressed (incremental review)._`;
  return base.length === 0 ? note : `${base}\n\n${note}`;
}

/**
 * Pull every ZAI_* + GITHUB_TOKEN input into a plain object via core.getInput.
 * `core.getInput` returns '' for unset inputs, which loadConfig handles.
 *
 * @param {{ getInput: (name: string) => string }} [coreDep]
 * @returns {Record<string, string>}
 */
export function readAllInputs(coreDep = core) {
  const inputs = {};
  for (const name of INPUT_NAMES) {
    inputs[name] = coreDep.getInput(name);
  }
  return inputs;
}

/* ------------------------------------------------------------------ *
 * run — the router
 * ------------------------------------------------------------------ */

/**
 * Route a single GitHub Actions event.
 *
 * `deps` lets every collaborator be overridden. Defaults wire the real lib
 * helpers so production works without passing them; tests inject fakes for
 * octokit, core, callApi, apiClient, handlers, and module helpers.
 *
 * Errors propagate (caller — `main` — catches).
 *
 * @param {object} context  the @actions/github context (or a plain object with the same shape).
 * @param {object} [deps]
 * @returns {Promise<void>}
 */
export async function run(context, deps = {}) {
  const {
    config,
    core: coreDep = core,
    octokit,
    callApi: injectedCallApi,
    apiClient: injectedApiClient,
    handlers = HANDLERS,
    // Module-helper overrides (tests inject spies; production uses the real fns).
    getChangedFiles: getChangedFilesFn = getChangedFiles,
    filterExcludedFiles: filterExcludedFilesFn = filterExcludedFiles,
    filterPatchableFiles: filterPatchableFilesFn = filterPatchableFiles,
    runStructuredReview: runStructuredReviewFn = runStructuredReview,
    isLargePr: isLargePrFn = isLargePr,
    resolveSystemPrompt: resolveSystemPromptFn = resolveSystemPrompt,
    formatFindingsAsSummary: formatFindingsAsSummaryFn = formatFindingsAsSummary,
    formatWalkthroughSummary: formatWalkthroughSummaryFn = formatWalkthroughSummary,
    partitionFindings: partitionFindingsFn = partitionFindings,
    buildReviewBody: buildReviewBodyFn = buildReviewBody,
    buildReviewComments: buildReviewCommentsFn = buildReviewComments,
    resolveReviewEvent: resolveReviewEventFn = resolveReviewEvent,
    upsertReview: upsertReviewFn = upsertReview,
    listBotReviews: listBotReviewsFn = listBotReviews,
    postFallbackComment: postFallbackCommentFn = postFallbackComment,
    hashFinding: hashFindingFn = hashFinding,
    buildFindingsHashBlock: buildFindingsHashBlockFn = buildFindingsHashBlock,
    parseFindingsHashBlock: parseFindingsHashBlockFn = parseFindingsHashBlock,
    filterIncrementalFindings: filterIncrementalFindingsFn = filterIncrementalFindings,
    runScanners: runScannersFn = runScanners,
    formatScannerContext: formatScannerContextFn = formatScannerContext,
    buildCommentBody: buildCommentBodyFn = buildCommentBody,
    upsertReviewComment: upsertReviewCommentFn = upsertReviewComment,
    parseCommand: parseCommandFn = parseCommand,
    authorize: authorizeFn = authorize,
    createApiClient: createApiClientFn = createApiClient,
    getPRContext: getPRContextFn = getPRContext,
    runScheduledReview: runScheduledReviewFn = runScheduledReview,
    setReviewStatus: setReviewStatusFn = setReviewStatus,
    buildStatusDescription: buildStatusDescriptionFn = buildStatusDescription,
    loadRepoConfig: loadRepoConfigFn = loadRepoConfig,
    mergeRepoConfig: mergeRepoConfigFn = mergeRepoConfig,
    loadCodeowners: loadCodeownersFn = loadCodeowners,
    suggestReviewers: suggestReviewersFn = suggestReviewers,
    formatSuggestedReviewersLine: formatSuggestedReviewersLineFn = formatSuggestedReviewersLine,
    pickAssignableReviewers: pickAssignableReviewersFn = pickAssignableReviewers,
    loadLearnings: loadLearningsFn = loadLearnings,
    filterFindingsByLearnings: filterFindingsByLearningsFn = filterFindingsByLearnings,
    formatLearningsForPrompt: formatLearningsForPromptFn = formatLearningsForPrompt,
  } = deps;

  const event = eventName(context);

  // ---- pull_request / pull_request_target → auto-review -------------
  // W2-3: route `pull_request_target` through the same review pipeline as
  // `pull_request`. events.js (CFG-6) already recognizes both as PR events via
  // isPullRequestEvent(), but this router previously only matched the literal
  // `pull_request` event name, so `pull_request_target` was silently dropped
  // ("Ignoring event: pull_request_target"). Both events now share the same
  // path so the action can be wired to either trigger in a workflow.
  //
  // SECURITY CONSIDERATION (pull_request_target): this event runs with the
  // base-branch's secrets AND write access to the repo (unlike `pull_request`,
  // which runs in a fork-sandboxed context). The review pipeline below only
  // (a) reads the PR diff via the GitHub API, (b) sends the diff to the LLM
  // via callApi, and (c) posts a review/comment back to GitHub. It does NOT
  // execute PR-supplied code, run build scripts, or check out the PR head — so
  // routing `pull_request_target` here does NOT introduce code-execution risk.
  // The write access is already required to post reviews on `pull_request`
  // anyway, and the same auth/permission surface applies. The only new
  // capability unlocked is that the review fires for fork PRs WITH secrets
  // available — operators who wire `pull_request_target` are responsible for
  // ensuring their config does not leak secrets into review output (the
  // sanitizer + prompt-hardening layers remain the controls there).
  if (event === 'pull_request' || event === 'pull_request_target') {
    // INT-2: only react to PR actions that warrant a fresh review. Without
    // this filter the action also fires on `closed`, `labeled`, `edited`, etc.
    // — burning API credits and posting duplicate reviews. Mirrors the
    // `issue_comment` action guard below. `prAction &&` keeps a missing action
    // field proceeding (defense-in-depth for unusual payload shapes).
    const prAction = context?.payload?.action;
    const ALLOWED_PR_ACTIONS = new Set([
      'opened',
      'synchronize',
      'reopened',
      'ready_for_review',
    ]);
    if (prAction && !ALLOWED_PR_ACTIONS.has(prAction)) {
      coreDep.info(`Ignoring pull_request action: ${prAction}`);
      return;
    }

    const { owner, repo } = context.repo ?? {};
    if (!owner || !repo) {
      // Missing context.repo would otherwise throw a TypeError on the
      // destructuring above; fail gracefully with a status instead.
      coreDep.setFailed('missing owner/repo in pull_request context');
      return;
    }
    const pullNumber = getPullNumber(context);
    if (pullNumber === null) {
      coreDep.setFailed('not a pull request');
      return;
    }

    let files = await getChangedFilesFn({ octokit, owner, repo, pullNumber });
    files = filterExcludedFilesFn(files, config.excludePatterns);
    const patchable = filterPatchableFilesFn(files);

    // Zero-patchable-files short-circuit: avoids a wasted synthesis call.
    if (patchable.length === 0) {
      coreDep.info('No patchable changes; skipping.');
      return;
    }

    // Phase 5: post a "pending" commit status at the START of the review so
    // developers see immediate feedback instead of staring at a silent PR for
    // minutes. Fail-soft (setReviewStatus never throws); gated by config so an
    // operator who lacks `statuses: write` can turn it off. The sha is the PR
    // head SHA from the pull_request payload.
    const sha = context?.payload?.pull_request?.head?.sha ?? '';
    if (config.commitStatus) {
      await setReviewStatusFn(
        {
          octokit,
          context,
          sha,
          state: 'pending',
          description: 'Z.ai review in progress…',
        },
        { core: coreDep },
      );
    }

    // Build (or accept an injected) callApi adapter that wraps api.js.
    const callApi = buildCallApi({
      injectedCallApi,
      injectedApiClient,
      createApiClientFn,
      config,
      resolveSystemPromptFn,
    });

    // Phase 3: in-repo `.zai.yml`. The file is fetched from the PR head SHA
    // and treated as UNTRUSTED (attacker-controllable in fork PRs). The merge
    // is security-critical: action inputs ALWAYS win on cost/security knobs;
    // the repo can only NARROW behavior (lower a cap, add path instructions,
    // add excludes, disable a scanner). loadRepoConfig NEVER throws — any
    // failure (404, parse error, oversized) returns `{}` + a warning. Tests
    // inject `deps.repoConfig` directly to bypass the fetch; production lets
    // loadRepoConfig run when the master switch is on.
    const rawRepoConfig = config.repoConfigEnabled
      ? await loadRepoConfigFn({ octokit, context, headSha: sha }, { core: coreDep })
      : {};
    const repoConfig = mergeRepoConfigFn(config, rawRepoConfig);

    // Phase 8.2: learnings / memory (`.zai/learnings.yml`). The file records
    // "previously-reviewed / won't-fix" patterns so the bot doesn't re-raise
    // the same finding on every run. OPT-IN (ZAI_LEARNINGS_ENABLED) because it
    // is a new trust surface: the file is attacker-controllable in fork PRs, so
    // a malicious contributor could otherwise commit an entry that suppresses a
    // real finding. loadLearnings is fail-soft (any error → [] + warning); the
    // suppression is conservative (glob + case-insensitive substring on both
    // axes). The accepted patterns are also carried into the prompt as additive
    // context (see learningsContext below).
    const learnings = config.learningsEnabled
      ? await loadLearningsFn({ octokit, context, headSha: sha }, { core: coreDep })
      : [];
    const learningsContext = formatLearningsForPromptFn(learnings);
    if (learnings.length > 0 && coreDep.info) {
      coreDep.info(
        `Learnings: ${learnings.length} accepted-pattern rule(s) loaded.`,
      );
    }

    // Deterministic scanners (Phase 4): run BEFORE the LLM. Their findings
    // become high-confidence findings directly (merged over LLM findings at
    // the same file:line+title) and are injected into the LLM prompt as
    // "already detected, don't re-report" context. Scanners NEVER fail the
    // review — on any error they log a warning and contribute [] findings.
    // Phase 3: repo `.zai.yml` scanners map onto the scanner orchestrator's
    // per-scanner toggles: `gitleaks` → secrets, `ast_grep` → patterns. The
    // repo can only DISABLE a scanner the action enabled (enforced by
    // mergeRepoConfig).
    const cacheDir = expandHome(config.scannersCacheDir);
    const scannerRepoConfig = {
      scanners: {
        secrets: repoConfig.scanners?.gitleaks === false ? false : undefined,
        patterns: repoConfig.scanners?.ast_grep === false ? false : undefined,
      },
    };
    const scannerResult = await runScannersFn(
      {
        files: patchable,
        repoPath: process.cwd(),
        cacheDir,
        config: { scannersEnabled: repoConfig.scannersEnabled },
        repoConfig: scannerRepoConfig,
      },
      createScannerDeps({ core: coreDep, cacheDir }),
    );
    const scannerContext = formatScannerContextFn(
      scannerResult.findings,
      scannerResult.metrics,
    );
    if (scannerResult.scannerNames.length > 0 && coreDep.info) {
      coreDep.info(
        `Scanners: ${scannerResult.findings.length} finding(s) from ` +
          `${scannerResult.scannerNames.join(', ')}.`,
      );
    }

    // Structured review: one path for both small and large PRs. Batching
    // handles small PRs (1 batch) and large PRs (N batches) uniformly. The
    // result is rendered as a structured-findings summary comment. Phase 3:
    // the merged repo config supplies pathInstructions/toneInstructions
    // (additive) and may LOWER maxFindings (repo can only narrow the cap).
    const result = await runStructuredReviewFn(
      patchable,
      {
        ...config,
        maxFindings: repoConfig.maxFindings,
        pathInstructions: repoConfig.pathInstructions,
        toneInstructions: repoConfig.toneInstructions,
        deterministicFindings: scannerResult.findings,
        scannerContext,
        learningsContext,
      },
      {
        callApi,
        core: coreDep,
      },
    );

    // Phase 5: flip the commit status to "success" with a findings summary now
    // that the review itself completed. The downstream review/comment posting
    // is UI delivery; the review result is what determines success. Fail-soft.
    if (config.commitStatus) {
      const criticalCount = result.findings.filter(
        (f) => f?.severity === 'critical',
      ).length;
      const highCount = result.findings.filter(
        (f) => f?.severity === 'high',
      ).length;
      await setReviewStatusFn(
        {
          octokit,
          context,
          sha,
          state: 'success',
          description: buildStatusDescriptionFn({
            findingCount: result.findings.length,
            criticalCount,
            highCount,
          }),
        },
        { core: coreDep },
      );
    }

    // Phase 2: partition findings into inline-mappable (anchored to diff lines
    // via pulls.createReview) and summary-only. When at least one finding maps
    // to a diff line, post a GitHub REVIEW with inline comments — the
    // CodeRabbit/Copilot experience — using dismiss-stale-then-post idempotency.
    // When NO finding maps (all file-level or unmappable), fall back to the
    // legacy single summary issue comment so the structured findings still
    // reach the PR.
    const reviewContext = {
      ...context,
      // The pull_request payload carries the PR number; expose it under
      // payload.issue.number too so the shared postComment fallback helper
      // (which reads payload.issue.number) works on this event.
      payload: {
        ...context.payload,
        issue: { number: pullNumber },
      },
    };

    // Phase 6.3: incremental review. On re-push, suppress findings whose
    // content hash is unchanged since the last bot review so only NEW or
    // CHANGED findings surface (CodeRabbit's auto_incremental_review pattern).
    // The hash block appended to the prior review body carries the full set;
    // we read it back here, filter, then re-emit a fresh full-set block on the
    // new review. Fail-soft: any error reading prior reviews is logged and the
    // run proceeds with the full findings set (no incremental suppression).
    let priorHashes = new Set();
    if (config.incrementalReview === true) {
      try {
        const priorReviews = await listBotReviewsFn({
          octokit,
          context: reviewContext,
          marker: MARKER,
        });
        // The most recent prior review is the canonical hash source. Reviews
        // come back newest-first from the GitHub API; fall back to scanning
        // any of them if the first lacks a hash block.
        const withHashBlock = priorReviews.find(
          (r) => typeof r?.body === 'string' && r.body.includes('<!-- zai-hashes:'),
        );
        if (withHashBlock) {
          priorHashes = parseFindingsHashBlockFn(withHashBlock.body);
        }
      } catch (priorErr) {
        if (coreDep?.warning) {
          coreDep.warning(
            `Could not read prior reviews for incremental filter (${priorErr?.message ?? String(priorErr)}); posting full findings.`,
          );
        }
      }
    }
    const { kept: incrementalKept, suppressed: suppressedCount } =
      filterIncrementalFindingsFn(result.findings, priorHashes);
    if (suppressedCount > 0 && coreDep?.info) {
      coreDep.info(
        `Incremental review: suppressed ${suppressedCount} previously-reported finding(s).`,
      );
    }

    // Phase 8.2: drop findings that match a previously-reviewed / won't-fix
    // learning. Applied AFTER incremental suppression so the two layers
    // compose. When learningsEnabled is off, `learnings` is [] and this is a
    // no-op (everything is kept). Conservative: a learning only suppresses when
    // the glob AND the substring both match.
    const { kept: keptFindings, suppressed: learningsSuppressed } =
      filterFindingsByLearningsFn(incrementalKept, learnings);
    if (learningsSuppressed > 0 && coreDep?.info) {
      coreDep.info(
        `Learnings: suppressed ${learningsSuppressed} previously-accepted finding(s).`,
      );
    }

    // The hash block is built from the FULL findings set (not just kept) so
    // the next run sees the complete canonical set — otherwise a finding that
    // was suppressed this run would re-surface on the next. Empty string when
    // incremental review is disabled OR there are no findings at all. NOTE: a
    // learning-suppressed finding is also part of this canonical set, so it
    // stays incremental-suppressed until its content changes; learnings
    // filtering re-applies on every run regardless, so correctness is preserved.
    const hashBlock =
      config.incrementalReview === true && Array.isArray(result.findings) && result.findings.length > 0
        ? buildFindingsHashBlockFn(result.findings)
        : '';

    // Append a "previously-resolved" note to the model's summary so reviewers
    // know what was elided. Only when suppression actually happened.
    // INT-11: surface BOTH incremental-suppressed and learnings-suppressed
    // counts so a run that only suppressed via learnings still reports it.
    const baseSummary = typeof result.summary === 'string' ? result.summary : '';
    const summaryWithIncrementalNote =
      suppressedCount > 0 || learningsSuppressed > 0
        ? appendIncrementalNote(baseSummary, suppressedCount, learningsSuppressed)
        : baseSummary;

    // Phase 8.1: CODEOWNERS-aware reviewer suggestions. Read-only by default
    // (a "Suggested reviewers" line appended to the summary prose so it shows
    // in BOTH the inline review body and the summary-only comment); opt-in
    // auto-assignment additionally calls pulls.requestReviewers (after the
    // review is posted, below). The CODEOWNERS file is fetched from the head
    // SHA and treated as UNTRUSTED; loadCodeowners is fail-soft to [] on any
    // error. autoAssignReviewers implies suggestReviewers.
    let suggestedReviewers = [];
    if (config.suggestReviewers || config.autoAssignReviewers) {
      try {
        const codeownersRules = await loadCodeownersFn(
          { octokit, context, headSha: sha },
          { core: coreDep },
        );
        if (codeownersRules.length > 0) {
          const filenames = patchable
            .map((f) => (typeof f?.filename === 'string' ? f.filename : ''))
            .filter((fn) => fn.length > 0);
          const suggestion = suggestReviewersFn(filenames, codeownersRules);
          suggestedReviewers = suggestion.suggestedReviewers;
        }
      } catch (err) {
        // Fail-soft: a broken CODEOWNERS path must never break the review.
        if (coreDep?.warning) {
          coreDep.warning(
            `CODEOWNERS reviewer suggestions failed (${err?.message ?? String(err)}); skipping.`,
          );
        }
      }
    }
    const suggestedReviewersLine = formatSuggestedReviewersLineFn(suggestedReviewers);
    // The suggestion line is carried through `metadata.suggestedReviewersLine`
    // to the three summary renderers (buildReviewBody, formatFindingsAsSummary,
    // formatWalkthroughSummary), which render it alongside the deterministic /
    // truncated metadata lines. (Appending to the summary prose does not work
    // for the flat findings path, which ignores the prose when findings=0.)
    const finalSummary = summaryWithIncrementalNote;

    // Phase 8.1: opt-in auto-assignment. Runs AFTER the review/comment is
    // posted (caller awaits this before returning). Fail-soft: any assignment
    // error (permissions, invalid users, rate limit) logs a warning and never
    // fails the review. Only `@user` handles are forwarded (teams are
    // summary-only). No-op when autoAssignReviewers is off or there are no
    // assignable users.
    const maybeAssignReviewers = async () => {
      if (!config.autoAssignReviewers) return;
      const reviewers = pickAssignableReviewersFn(suggestedReviewers);
      if (reviewers.length === 0) return;
      try {
        await octokit.rest.pulls.requestReviewers({
          owner,
          repo,
          pull_number: pullNumber,
          reviewers,
        });
        if (coreDep?.info) {
          coreDep.info(
            `CODEOWNERS: requested ${reviewers.length} reviewer(s): ${reviewers.join(', ')}.`,
          );
        }
      } catch (err) {
        if (coreDep?.warning) {
          coreDep.warning(
            `CODEOWNERS: failed to request reviewers (${err?.message ?? String(err)}); skipping.`,
          );
        }
      }
    };

    const { inline, summaryOnly } = partitionFindingsFn(keptFindings, patchable);

    const truncatedCount = Math.max(
      0,
      (result.metadata.totalFindingsBeforeCap || 0) - result.findings.length,
    );
    const reviewMetadata = {
      reviewerName: config.reviewerName,
      deterministicFindingsCount: result.metadata.deterministicFindingsCount,
      truncated: truncatedCount,
      // Phase 7: walkthrough context for the summary-only section of the
      // review body. When config.walkthrough is true, buildReviewBody renders
      // the summary-only findings as dependency-ordered cohort sections
      // (collapsible <details>) instead of a flat bullet list. Inline comments
      // are line-anchored and unaffected.
      walkthrough: config.walkthrough === true,
      files: patchable,
      // Phase 8.1: pre-rendered "Suggested reviewers" line (empty string when
      // disabled/no CODEOWNERS/no matches → rendered as nothing).
      suggestedReviewersLine,
    };

    if (inline.length > 0) {
      // Build the review body (summary + summary-only findings + marker) and
      // the inline comments array, then submit as a GitHub review. Phase 6.3:
      // the hash block is appended AFTER the marker so listBotReviews' marker
      // scan (which searches for `<!-- zai-code-review -->`) keeps working
      // unchanged — the two HTML comments coexist in the same body. The SHA
      // block is appended for the same reason AND so the scheduled-review
      // dedup-by-SHA (hasReviewForSha) recognizes this body on the next cron
      // tick — without it, a push-reviewed PR is re-reviewed every schedule.
      const baseBody = buildReviewBodyFn(
        finalSummary,
        summaryOnly,
        reviewMetadata,
      );
      const shaBlock = buildShaBlock(sha);
      const reviewBody = appendTrailers(baseBody, [hashBlock, shaBlock]);
      const comments = buildReviewCommentsFn(inline);
      // Phase 8.3: strict mode escalates the review event from advisory
      // COMMENT to blocking REQUEST_CHANGES when strictMode is on AND there is
      // a critical/high finding. Off by default; never auto-enabled.
      const reviewEvent = resolveReviewEventFn(keptFindings, config);
      try {
        await upsertReviewFn({
          octokit,
          context: reviewContext,
          marker: MARKER,
          sha,
          body: reviewBody,
          comments,
          event: reviewEvent,
          core: coreDep,
        });
        await maybeAssignReviewers();
        return;
      } catch (reviewError) {
        // NEVER silently lose the review. Fall back to a single issue comment
        // carrying the review body + every finding as text, then rethrow-free.
        if (coreDep?.warning) {
          coreDep.warning(
            `Review submission failed (${reviewError?.message ?? String(reviewError)}); posting fallback comment.`,
          );
        }
        const fallbackBody = buildFallbackBody(
          reviewBody,
          keptFindings,
          config.reviewerName,
        );
        await postFallbackCommentFn({
          octokit,
          context: reviewContext,
          body: fallbackBody,
        });
        await maybeAssignReviewers();
        return;
      }
    }

    // No inline-mappable findings: post the whole summary as an issue comment
    // via the existing marker-upsert path (keeps idempotency for the
    // no-findings / all-file-level case). When walkthrough is enabled (default)
    // and there are findings, render as a dependency-ordered walkthrough;
    // otherwise fall back to the flat severity-grouped summary. Phase 6.3:
    // the summary uses the KEPT findings (after incremental suppression) and
    // the hash block is appended after the marker (same coexistence model as
    // the inline-review branch).
    const useWalkthrough =
      config.walkthrough && Array.isArray(keptFindings) && keptFindings.length > 0;
    const summaryMetadata = {
      deterministicFindingsCount: result.metadata.deterministicFindingsCount,
      truncated: truncatedCount,
      summary: finalSummary,
      // Phase 8.1: pre-rendered "Suggested reviewers" line.
      suggestedReviewersLine,
    };
    const content = useWalkthrough
      ? formatWalkthroughSummaryFn(keptFindings, patchable, {
          reviewerName: config.reviewerName,
          metadata: summaryMetadata,
        })
      : formatFindingsAsSummaryFn(keptFindings, {
          reviewerName: config.reviewerName,
          metadata: summaryMetadata,
        });
    const commentBody = buildCommentBodyFn({
      title: config.reviewerName,
      content,
      marker: MARKER,
    });
    // Append hash + SHA blocks (same coexistence model as the inline branch).
    const shaBlock = buildShaBlock(sha);
    const body = appendTrailers(commentBody, [hashBlock, shaBlock]);
    await upsertReviewCommentFn({
      octokit,
      owner,
      repo,
      issueNumber: pullNumber,
      body,
      marker: MARKER,
      core: coreDep,
    });
    await maybeAssignReviewers();
    return;
  }

  // ---- issue_comment → command path ---------------------------------
  if (event === 'issue_comment') {
    // Defense-in-depth: only react to `created` comments. The shipped example
    // workflow triggers on `types: [created]`, but a consumer who broadens it
    // to `[created, edited]` could let an authorized user re-fire commands by
    // editing an old comment. Do not assume the workflow's types filter.
    const action = context?.payload?.action;
    if (action && action !== 'created') {
      coreDep.info(`Ignoring issue_comment action: ${action}`);
      return;
    }

    if (!config.commandsEnabled) {
      coreDep.info('Commands disabled; ignoring comment.');
      return;
    }
    if (isBotComment(context)) {
      // Anti-loop: never react to our own or other bots' comments.
      return;
    }
    const pullNumber = getPullNumber(context);
    if (pullNumber === null) {
      // Not a PR comment (pure issue); nothing for the bot to do.
      return;
    }

    const commentText = context.payload?.comment?.body ?? '';
    const parsed = parseCommandFn(commentText);
    if (parsed.error === 'NOT_A_COMMAND') {
      return; // ordinary comment, ignore silently
    }
    if (parsed.error) {
      // MALFORMED_INPUT or UNKNOWN_COMMAND: log quietly and return. Do NOT spam.
      coreDep.info(`Ignoring unrecognized command (${parsed.error}).`);
      return;
    }

    // ---- AUTH (the live gate) ----
    const commenter = getCommenter(context);
    // The issue_comment payload does NOT carry fork-ness, so isForkPullRequest
    // is always false here. When the fork gate is active (allowForkCommands
    // disabled), resolve fork-ness via the PR API so the in-code promise —
    // "ZAI_ALLOW_FORK_COMMANDS:false blocks fork-PR commands" — actually holds.
    let isFork = isForkPullRequest(context);
    if (!isFork && config.allowForkCommands !== true) {
      try {
        const pr = await getPRContextFn({ octokit, context });
        // Fail CLOSED: if getPRContextFn returns null (not throws), treat the
        // PR as a fork so a broken/empty API response cannot open the gate.
        isFork = pr ? Boolean(pr.isFork) : true;
      } catch (error) {
        // If the PR lookup fails, fail CLOSED: treat as a fork so a broken API
        // call cannot let a fork command through the gate.
        isFork = true;
        coreDep.info('PR lookup failed during fork check; treating as fork.');
      }
    }
    const authResult = authorizeFn({
      comment: context.payload?.comment,
      sender: context.payload?.sender,
      isFork,
      config,
    });
    if (!authResult.authorized) {
      if (authResult.silent) {
        coreDep.info(
          'Blocked command from unauthorized user: ' +
            (commenter?.login ?? 'unknown'),
        );
      }
      // No reaction, no comment — silent block either way.
      return;
    }

    // ---- dispatch ----
    const handler = handlers[parsed.command];
    if (!handler) {
      coreDep.warning('No handler for command: ' + parsed.command);
      return;
    }
    const callApi = buildCallApi({
      injectedCallApi: deps.callApi,
      injectedApiClient: deps.apiClient,
      createApiClientFn,
      config,
      resolveSystemPromptFn,
    });
    await handler({
      octokit,
      context,
      config,
      core: coreDep,
      commenter,
      args: parsed.args,
      callApi,
    });
    return;
  }

  // ---- schedule → batch re-review of open PRs -----------------------
  if (event === 'schedule') {
    if (!config.scheduleEnabled) {
      coreDep.info('Schedule disabled; nothing to do.');
      return;
    }
    const { owner, repo } = context.repo;
    const callApi = buildCallApi({
      injectedCallApi: deps.callApi,
      injectedApiClient: deps.apiClient,
      createApiClientFn,
      config,
      resolveSystemPromptFn,
    });
    await runScheduledReviewFn({
      octokit,
      owner,
      repo,
      config,
      core: coreDep,
      callApi,
      getChangedFiles: getChangedFilesFn,
      filterExcludedFiles: filterExcludedFilesFn,
      filterPatchableFiles: filterPatchableFilesFn,
      runStructuredReview: runStructuredReviewFn,
      isLargePr: isLargePrFn,
      formatFindingsAsSummary: formatFindingsAsSummaryFn,
      buildCommentBody: buildCommentBodyFn,
      upsertReviewComment: upsertReviewCommentFn,
      // v2 inline-review pipeline (mirrors the pull_request branch).
      partitionFindings: partitionFindingsFn,
      buildReviewBody: buildReviewBodyFn,
      buildReviewComments: buildReviewCommentsFn,
      upsertReview: upsertReviewFn,
      postFallbackComment: postFallbackCommentFn,
      resolveReviewEvent: resolveReviewEventFn,
    });
    return;
  }

  // ---- everything else ----------------------------------------------
  coreDep.info('Ignoring event: ' + event);
}

/* ------------------------------------------------------------------ *
 * callApi adapter factory (shared by both paths)
 * ------------------------------------------------------------------ */

/**
 * Build the `callApi(apiKey, model, prompt)` adapter used by both the
 * auto-review pipeline and the command handlers. Tests inject `injectedCallApi`
 * directly to bypass api.js entirely.
 *
 * The adapter wraps the api.js client: it calls `client.call(...)`, throws on
 * `!r.success` (so the retry loop's redacted error message propagates), and
 * resolves to `r.data` on success.
 *
 * @param {object} args
 * @returns {(apiKey: string, model: string, prompt: string) => Promise<string>}
 */
function buildCallApi({
  injectedCallApi,
  injectedApiClient,
  createApiClientFn,
  config,
  resolveSystemPromptFn,
}) {
  if (injectedCallApi) return injectedCallApi;
  // Factory config: timeout always; fallbackPrompt only when set to a
  // non-empty string (otherwise the client default — no fallback — applies).
  const factoryConfig = { timeout: config.timeoutMs };
  if (typeof config.fallbackPrompt === 'string' && config.fallbackPrompt.length > 0) {
    factoryConfig.fallbackPrompt = config.fallbackPrompt;
  }
  const client = injectedApiClient ?? createApiClientFn(factoryConfig);
  const systemPrompt = resolveSystemPromptFn(config);
  return (apiKey, model, prompt) =>
    client
      .call({
        apiKey,
        model,
        systemPrompt,
        userPrompt: prompt,
        ...(config.temperature != null ? { temperature: config.temperature } : {}),
        ...(config.maxTokens != null ? { maxTokens: config.maxTokens } : {}),
      })
      .then((r) => {
        if (!r.success) throw new Error(r.error.message);
        return r.data;
      });
}

/* ------------------------------------------------------------------ *
 * main — what the action runner invokes
 * ------------------------------------------------------------------ */

/**
 * Build config from action inputs and call {@link run}. Errors propagate to
 * the top-level `.catch`, which calls `core.setFailed`. On a hard failure,
 * best-effort posts a "failure" commit status so developers aren't left
 * staring at a forever-pending status.
 *
 * @returns {Promise<void>}
 */
export async function main() {
  const inputs = readAllInputs(core);
  const config = loadConfig(inputs, { core });
  const octokit = github.getOctokit(config.githubToken);
  try {
    return await run(github.context, {
      config,
      core,
      github,
      octokit,
    });
  } catch (err) {
    // Phase 5: flip the commit status to "failure" on a hard error. Best-effort
    // only — setReviewStatus swallows its own errors and never throws, so this
    // can never mask the original failure. Only fires for pull_request events
    // (where a head SHA exists) and when status feedback is enabled.
    if (config.commitStatus) {
      const sha = github.context?.payload?.pull_request?.head?.sha;
      if (sha) {
        await setReviewStatus(
          {
            octokit,
            context: github.context,
            sha,
            state: 'failure',
            description: 'Z.ai review failed',
          },
          { core },
        );
      }
    }
    throw err;
  }
}

// Auto-run ONLY when this file is the process entry point. Import-safe.
if (isMainEntry()) {
  main().catch((err) => core.setFailed(err?.message ?? String(err)));
}
