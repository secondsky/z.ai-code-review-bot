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
import { upsertReviewComment, buildCommentBody, MARKER } from './lib/comments.js';
import {
  getChangedFiles,
  filterExcludedFiles,
  filterPatchableFiles,
} from './lib/changed-files.js';
import { resolveSystemPrompt } from './lib/prompt.js';
import { runStructuredReview, isLargePr } from './lib/auto-review.js';
import { formatFindingsAsSummary } from './lib/findings.js';
import { parseCommand } from './lib/commands.js';
import { HANDLERS } from './lib/handlers/index.js';
import { getPRContext } from './lib/handlers/_shared.js';
import { runScheduledReview } from './lib/schedule.js';

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
  'GITHUB_TOKEN',
];

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
    buildCommentBody: buildCommentBodyFn = buildCommentBody,
    upsertReviewComment: upsertReviewCommentFn = upsertReviewComment,
    parseCommand: parseCommandFn = parseCommand,
    authorize: authorizeFn = authorize,
    createApiClient: createApiClientFn = createApiClient,
    getPRContext: getPRContextFn = getPRContext,
    runScheduledReview: runScheduledReviewFn = runScheduledReview,
  } = deps;

  const event = eventName(context);

  // ---- pull_request → auto-review -----------------------------------
  if (event === 'pull_request') {
    const { owner, repo } = context.repo;
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

    // Build (or accept an injected) callApi adapter that wraps api.js.
    const callApi = buildCallApi({
      injectedCallApi,
      injectedApiClient,
      createApiClientFn,
      config,
      resolveSystemPromptFn,
    });

    // Structured review: one path for both small and large PRs. Batching
    // handles small PRs (1 batch) and large PRs (N batches) uniformly. The
    // result is rendered as a structured-findings summary comment.
    const result = await runStructuredReviewFn(patchable, config, {
      callApi,
      core: coreDep,
    });

    const content = formatFindingsAsSummaryFn(result.findings, {
      reviewerName: config.reviewerName,
      metadata: {
        deterministicFindingsCount: result.metadata.deterministicFindingsCount,
        truncated: Math.max(
          0,
          (result.metadata.totalFindingsBeforeCap || 0) - result.findings.length,
        ),
      },
    });

    const body = buildCommentBodyFn({
      title: config.reviewerName,
      content,
      marker: MARKER,
    });
    await upsertReviewCommentFn({
      octokit,
      owner,
      repo,
      issueNumber: pullNumber,
      body,
      marker: MARKER,
      core: coreDep,
    });
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
        isFork = Boolean(pr?.isFork);
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
  const client = injectedApiClient ?? createApiClientFn({ timeout: config.timeoutMs });
  const systemPrompt = resolveSystemPromptFn(config);
  return (apiKey, model, prompt) =>
    client
      .call({ apiKey, model, systemPrompt, userPrompt: prompt })
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
 * the top-level `.catch`, which calls `core.setFailed`.
 *
 * @returns {Promise<void>}
 */
export async function main() {
  const inputs = readAllInputs(core);
  const config = loadConfig(inputs, { core });
  return run(github.context, {
    config,
    core,
    github,
    octokit: github.getOctokit(config.githubToken),
  });
}

// Auto-run ONLY when this file is the process entry point. Import-safe.
if (isMainEntry()) {
  main().catch((err) => core.setFailed(err?.message ?? String(err)));
}
