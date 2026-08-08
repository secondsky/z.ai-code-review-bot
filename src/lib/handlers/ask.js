/**
 * `/zai ask <question>` — answer a question about the PR.
 *
 * Builds a USER prompt from the PR context (title/body + the changed files'
 * patches, capped) plus the user's question, calls the injected `callApi`
 * (which already applies the system prompt), and posts the answer as a
 * comment.
 *
 * Contract invariants (shared by all six handlers):
 *   - Same `deps = {}` DI seam; same injected `callApi(apiKey, model, userPrompt)`.
 *   - NEVER throws — errors become a short comment + return.
 *   - No `@actions/core` import; no direct network (callApi + injected octokit).
 *   - callApi rejection → a fixed short error comment (NOT the raw error).
 */
import { postComment, getPRContext } from './_shared.js';
import { wrapUntrusted } from '../prompt.js';
import { getChangedFiles, filterPatchableFiles } from '../changed-files.js';

/** Soft cap on the diff context bundled into the prompt. */
const MAX_CONTEXT_CHARS = 8000;

/** Fixed error comment (no raw error leakage). */
const ERROR_COMMENT = '> ⚠️ Z.ai request failed. Please try again.';

/** Guidance when the user issues `/zai ask` with no question. */
const EMPTY_ARGS_COMMENT =
  '> Please provide a question: `/zai ask <question>`';

/**
 * Build the diff context block from patchable files, capped to a char budget.
 *
 * Pure (exported for testing).
 *
 * @param {Array<{filename: string, patch?: string}>} files
 * @param {number} [maxChars]
 * @returns {string}
 */
export function buildDiffContext(files, maxChars = MAX_CONTEXT_CHARS) {
  const patchable = filterPatchableFiles(files || []);
  if (patchable.length === 0) return '(no textual diffs available)';
  const lines = [];
  let used = 0;
  for (const f of patchable) {
    const entry = `### ${f.filename}\n\`\`\`diff\n${f.patch}\n\`\`\``;
    if (used + entry.length > maxChars) break;
    lines.push(entry);
    used += entry.length + 2; // +2 for the '\n\n' joiner
  }
  if (lines.length === 0) return '(no textual diffs available)';
  return lines.join('\n\n');
}

/**
 * Build the ask USER prompt. Pure (exported for testing).
 *
 * @param {object} p
 * @param {string} p.question
 * @param {string} p.commenterLogin
 * @param {{title?: string, body?: string}} p.pr
 * @param {Array<{filename: string, patch?: string}>} p.files
 * @returns {string}
 */
export function buildAskPrompt({ question, commenterLogin, pr, files }) {
  const title = pr?.title ? `**Title:** ${pr.title}\n` : '';
  const body = pr?.body ? `**Description:**\n${pr.body}\n` : '';
  const prContext = `${title}${body}${buildDiffContext(files)}`;
  return [
    `Question from @${commenterLogin || 'unknown'}: ${question}`,
    '',
    wrapUntrusted(prContext, 'pr-context'),
  ].join('\n');
}

/**
 * Handle `/zai ask`.
 *
 * @param {object} args  `{ octokit, context, config, core, commenter, args, callApi }`
 * @param {object} [deps={}]
 * @param {(o: object) => Promise<*>} [deps.post]
 * @param {(o: object) => Promise<*>} [deps.getPRContext]
 * @param {(o: object) => Promise<Array>} [deps.getChangedFiles]
 * @returns {Promise<void>}
 */
export async function handleAskCommand(
  { octokit, context, config = {}, core, commenter, args, callApi } = {},
  deps = {},
) {
  const {
    post = (body) => postComment({ octokit, context, body }),
    getPRContext: getCtx = (o) => getPRContext(o),
    getChangedFiles: getFiles = (o) => getChangedFiles(o),
  } = deps;

  const question = typeof args === 'string' ? args.trim() : '';
  if (question === '') {
    await post(EMPTY_ARGS_COMMENT);
    return;
  }

  const owner = context?.repo?.owner;
  const repo = context?.repo?.repo;
  const pullNumber = context?.payload?.issue?.number;

  try {
    const [pr, files] = await Promise.all([
      getCtx({ octokit, context }),
      typeof pullNumber === 'number'
        ? getFiles({ octokit, owner, repo, pullNumber })
        : Promise.resolve([]),
    ]);

    const prompt = buildAskPrompt({
      question,
      commenterLogin: commenter?.login,
      pr: pr || {},
      files: files || [],
    });

    const answer = await callApi(config.apiKey, config.model, prompt);
    await post(answer);
  } catch (error) {
    if (core?.warning) {
      core.warning(`ask handler failed: ${error?.message ?? error}`);
    }
    try {
      await post(ERROR_COMMENT);
    } catch {
      /* last-resort: nothing more we can do; never throw. */
    }
  }
}
