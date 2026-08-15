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
  filterExcludedFiles,
  filterPatchableFiles,
} from '../changed-files.js';
import { buildStructuredReviewPrompt, wrapUntrusted } from '../prompt.js';

/** Fixed error comment (no raw error leakage). */
const ERROR_COMMENT = '> ⚠️ Z.ai request failed. Please try again.';

/** Cap on whole-PR diff size passed to callApi. */
const MAX_WHOLE_PR_DIFF_CHARS = 8000;

/**
 * Reject path-traversal and other unsafe path patterns.
 *
 * Checks:
 *   - Non-string or empty → unsafe.
 *   - Leading `/` (absolute path) → unsafe.
 *   - Embedded null bytes or other control chars → unsafe.
 *   - `..` as a PATH SEGMENT (e.g. `../`, `/..`, or exactly `..`) → unsafe.
 *     Double-dots INSIDE a filename (`my..file.js`) are NOT traversal and
 *     are allowed.
 *
 * Pure (exported for testing).
 *
 * @param {string} path
 * @returns {boolean}
 */
export function isUnsafePath(path) {
  if (typeof path !== 'string' || path === '') return true;
  if (path.startsWith('/')) return true;
  // Reject embedded control characters (null bytes, etc.).
  if (/[\x00-\x1f]/.test(path)) return true;
  // Reject `..` only when it appears as a path segment — preceded by `/` or
  // start-of-string, AND followed by `/` or end-of-string. This catches
  // `../`, `/..`, `..`, and `a/../b` without rejecting `my..file.js`.
  if (/(?:^|\/)\.\.(?:\/|$)/.test(path)) return true;
  return false;
}

/**
 * Build the focused single-file review USER prompt. Pure (exported for testing).
 *
 * W16-B4-3: the patch is capped using the SAME resolution as the whole-PR
 * path (MAX_WHOLE_PR_DIFF_CHARS default; `options.maxDiffChars` override
 * where 0 = the config-level "unlimited" sentinel). Previously the patch was
 * interpolated raw — a 3000-line file produced a ~104k-char prompt while the
 * whole-PR path capped at 8000.
 *
 * @param {{filename: string, status?: string, patch?: string}} file
 * @param {{maxDiffChars?: number}} [options]
 * @returns {string}
 */
export function buildFileReviewPrompt(file, options = {}) {
  const maxDiffChars =
    typeof options.maxDiffChars === 'number' && options.maxDiffChars >= 0
      ? options.maxDiffChars
      : MAX_WHOLE_PR_DIFF_CHARS;
  let patch = file.patch || '(no textual diff available)';
  // 0 = unlimited sentinel (config.js) — skip truncation, like the whole-PR path.
  if (maxDiffChars > 0 && patch.length > maxDiffChars) {
    patch = `${patch.slice(0, maxDiffChars)}\n… (diff truncated)`;
  }
  return [
    'Please review the following file change from this pull request.',
    'Focus on concrete bugs, security issues, risky logic, and architecture',
    'mismatches visible in this diff. Skip trivial style comments.',
    '',
    wrapUntrusted(
      `### ${file.filename} (${file.status || 'modified'})\n` +
        '```diff\n' +
        `${patch}\n` +
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
        // W16-B4-3: thread config.maxDiffChars so the single-file path uses
        // the same cap resolution as the whole-PR path below.
        buildFileReviewPrompt(match, { maxDiffChars: config.maxDiffChars }),
      );
      await post(review);
      return;
    }

    // ---- whole-PR path ----
    // W15-A8-8: apply the action-level EXCLUDE_PATTERNS before the patchable
    // filter, mirroring the auto-review path in index.js — previously only
    // filterPatchableFiles ran here, so lockfiles got reviewed despite the
    // default excludes. (.zai.yml path_filters are merged into a repoConfig
    // that is local to index.js run() and is not passed to comment handlers;
    // action-level excludePatterns are the reachable, correct scope here.)
    const notExcluded = filterExcludedFiles(files || [], config.excludePatterns);
    const patchable = filterPatchableFiles(notExcluded);
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
