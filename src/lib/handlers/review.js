/**
 * `/zai review [file]` — review a specific file (or the whole PR).
 *
 * - With a file path: validate it's one of the PR's changed files (rejecting
 *   path traversal: any path containing `..` or starting with `/`), then build
 *   a focused review prompt for just that file's patch.
 * - Without args: reuse {@link buildStructuredReviewPrompt} on the patchable
 *   changed files (capped) to review the whole-PR diff.
 *
 * Contract invariants: same `deps = {}` seam; same injected `callApi`; NEVER
 * throws (errors → short comment + return); no `@actions/core` import; no
 * direct network.
 */
import { postComment } from './_shared.js';
import {
  getChangedFiles,
  filterPatchableFiles,
} from '../changed-files.js';
import { buildStructuredReviewPrompt, wrapUntrusted } from '../prompt.js';

/** Fixed error comment (no raw error leakage). */
const ERROR_COMMENT = '> ⚠️ Z.ai request failed. Please try again.';

/** Cap on whole-PR diff size passed to callApi. */
const MAX_WHOLE_PR_DIFF_CHARS = 8000;

/**
 * Reject path-traversal: any path containing `..` or starting with `/`.
 *
 * Pure (exported for testing).
 *
 * @param {string} path
 * @returns {boolean}
 */
export function isUnsafePath(path) {
  if (typeof path !== 'string' || path === '') return true;
  if (path.startsWith('/')) return true;
  if (path.includes('..')) return true;
  return false;
}

/**
 * Build the focused single-file review USER prompt. Pure (exported for testing).
 *
 * @param {{filename: string, status?: string, patch?: string}} file
 * @returns {string}
 */
export function buildFileReviewPrompt(file) {
  return [
    'Please review the following file change from this pull request.',
    'Focus on concrete bugs, security issues, risky logic, and architecture',
    'mismatches visible in this diff. Skip trivial style comments.',
    '',
    wrapUntrusted(
      `### ${file.filename} (${file.status || 'modified'})\n` +
        '```diff\n' +
        `${file.patch || '(no textual diff available)'}\n` +
        '```',
      'file-diff',
    ),
  ].join('\n');
}

/**
 * Handle `/zai review`.
 *
 * @param {object} args  `{ octokit, context, config, core, commenter, args, callApi }`
 * @param {object} [deps={}]
 * @param {(o: object) => Promise<*>} [deps.post]
 * @param {(o: object) => Promise<Array>} [deps.getChangedFiles]
 * @returns {Promise<void>}
 */
export async function handleReviewCommand(
  { octokit, context, config = {}, core, commenter, args, callApi } = {},
  deps = {},
) {
  const {
    post = (body) => postComment({ octokit, context, body }),
    getChangedFiles: getFiles = (o) => getChangedFiles(o),
  } = deps;

  const owner = context?.repo?.owner;
  const repo = context?.repo?.repo;
  const pullNumber = context?.payload?.issue?.number;

  try {
    const files =
      typeof pullNumber === 'number'
        ? await getFiles({ octokit, owner, repo, pullNumber })
        : [];

    const target = typeof args === 'string' ? args.trim() : '';

    // ---- specific-file path ----
    if (target !== '') {
      if (isUnsafePath(target)) {
        await post(`> \`${target}\` is not a valid file path.`);
        return;
      }
      const match = (files || []).find((f) => f?.filename === target);
      if (!match) {
        await post(`> File \`${target}\` is not part of this PR.`);
        return;
      }
      const review = await callApi(
        config.apiKey,
        config.model,
        buildFileReviewPrompt(match),
      );
      await post(review);
      return;
    }

    // ---- whole-PR path ----
    const patchable = filterPatchableFiles(files || []);
    if (patchable.length === 0) {
      await post('> No textual changes to review in this PR.');
      return;
    }
    const prompt = buildStructuredReviewPrompt(patchable, {
      // Pass maxDiffChars through when it's a number >= 0. The `0` value is
      // the config-level sentinel meaning "unlimited" (config.js: 0 disables
      // truncation), so it must reach buildStructuredReviewPrompt rather than
      // being replaced by MAX_WHOLE_PR_DIFF_CHARS.
      maxDiffChars:
        typeof config.maxDiffChars === 'number' && config.maxDiffChars >= 0
          ? config.maxDiffChars
          : MAX_WHOLE_PR_DIFF_CHARS,
    });
    const review = await callApi(config.apiKey, config.model, prompt);
    await post(review);
  } catch (error) {
    if (core?.warning) {
      core.warning(`review handler failed: ${error?.message ?? error}`);
    }
    try {
      await post(ERROR_COMMENT);
    } catch {
      /* last-resort: never throw out of the handler. */
    }
  }
}
