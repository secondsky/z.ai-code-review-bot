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
import {
  postComment,
  getPRContext,
  buildDiffContext,
  MAX_CONTEXT_CHARS,
  runCommand,
} from './_shared.js';
import { wrapUntrusted } from '../prompt.js';
import { getChangedFiles } from '../changed-files.js';

// F-DIFFCTX: buildDiffContext is owned by _shared.js (it was byte-identical
// here and in impact.js). Re-exported to preserve this module's public
// surface (tests import it from ask.js).
export { buildDiffContext } from './_shared.js';

/**
 * CMD-9: hard cap on the user-supplied question length. Prevents a
 * cost/quota brute-force via an enormous `/zai ask` body.
 */
const MAX_QUESTION_CHARS = 4000;

/**
 * W15-A4-5: hard cap on the PR body length. The PR description is
 * attacker-controllable (fork PRs) and was previously interpolated
 * UNTRUNCATED — a 60k body made a 60k prompt even though the question is
 * capped at 4000 and the diffs at 8000.
 */
const MAX_BODY_CHARS = 4000;

/** Guidance when the user issues `/zai ask` with no question. */
const EMPTY_ARGS_COMMENT =
  '> Please provide a question: `/zai ask <question>`';

/**
 * Build the ask USER prompt. Pure (exported for testing).
 *
 * @param {object} p
 * @param {string} p.question
 * @param {string} p.commenterLogin
 * @param {{title?: string, body?: string}} p.pr
 * @param {Array<{filename: string, patch?: string}>} p.files
 * @param {string[]} [p.excludePatterns]  Threaded to buildDiffContext (W16-B4-4).
 * @returns {string}
 */
export function buildAskPrompt({
  question,
  commenterLogin,
  pr,
  files,
  excludePatterns,
}) {
  const title = pr?.title ? `**Title:** ${pr.title}\n` : '';
  // W15-A4-5: cap the (attacker-controllable) PR body before interpolation.
  // The whole prContext (title + body + diffs) is wrapped via wrapUntrusted
  // below, so the truncation does not weaken the untrusted-content wrapping.
  const body = pr?.body
    ? `**Description:**\n${pr.body.slice(0, MAX_BODY_CHARS)}\n`
    : '';
  const prContext = `${title}${body}${buildDiffContext(
    files,
    MAX_CONTEXT_CHARS,
    excludePatterns,
  )}`;
  // W2-SEC-1: the user's question is the most direct prompt-injection vector
  // and must be wrapped in <untrusted_input> tags before being interpolated
  // into the prompt (the PR context was already wrapped via wrapUntrusted;
  // the question — the user's literal text — must receive the same defense).
  // The commenter login comes from the GitHub API (safe) and stays outside
  // the wrapper so the model can still address the user.
  const login = commenterLogin || 'unknown';
  const wrappedQuestion = wrapUntrusted(question, 'user-question');
  return [
    `Question from @${login}:`,
    '',
    wrappedQuestion,
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

  // CMD-9: cap the question length before building the prompt so an enormous
  // `/zai ask` body cannot brute-force the model's cost/quota.
  const question = (typeof args === 'string' ? args.trim() : '').slice(
    0,
    MAX_QUESTION_CHARS,
  );

  const owner = context?.repo?.owner;
  const repo = context?.repo?.repo;
  const pullNumber = context?.payload?.issue?.number;

  // F-RUNCOMMAND: the outer never-throw scaffold (warning + ERROR_COMMENT
  // fallback post) is owned by runCommand in _shared.js.
  return runCommand('ask', { core, post }, async () => {
    // W16-B4-2: this post (like every other in the handler) must be inside
    // the guarded body — it previously executed OUTSIDE it, so a transient
    // 502 on this single createComment rejected the whole handler and failed
    // the entire action (the router dispatches with no catch).
    if (question === '') {
      await post(EMPTY_ARGS_COMMENT);
      return;
    }

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
      excludePatterns: config.excludePatterns,
    });

    const answer = await callApi(config.apiKey, config.model, prompt);
    await post(answer);
  });
}
