/**
 * `/zai impact` — assess the change's impact/risk.
 *
 * Fetches the changed files (+patches, capped), builds a prompt asking for a
 * risk assessment with a severity level (🟢 low / 🟡 medium / 🟠 high / 🔴
 * critical) and rationale, and posts the result as a COMMENT.
 *
 * v1 READ-ONLY INVARIANT: this handler does NOT apply labels. The fork did
 * (via `issues.addLabels`) — that is a side effect we deliberately reject for
 * v1. The assessment is posted as a comment only; a human can act on it. No
 * `issues.addLabels` is ever called here.
 *
 * Contract invariants: same `deps = {}` seam; same injected `callApi`; NEVER
 * throws; no `@actions/core` import; no direct network.
 */
import { postComment } from './_shared.js';
import {
  getChangedFiles,
  filterPatchableFiles,
} from '../changed-files.js';

/** Fixed error comment (no raw error leakage). */
const ERROR_COMMENT = '> ⚠️ Z.ai request failed. Please try again.';

/** Cap on the diff context bundled into the prompt. */
const MAX_CONTEXT_CHARS = 8000;

/**
 * Build the diff context block from patchable files, capped to a char budget.
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
    used += entry.length + 2;
  }
  if (lines.length === 0) return '(no textual diffs available)';
  return lines.join('\n\n');
}

/**
 * Build the impact USER prompt. Pure (exported for testing).
 *
 * @param {Array<{filename: string, patch?: string}>} files
 * @returns {string}
 */
export function buildImpactPrompt(files) {
  return [
    'Assess the impact and risk of the following pull-request changes.',
    'Begin your response with a severity level on its own first line, using',
    'one of: 🟢 low, 🟡 medium, 🟠 high, 🔴 critical.',
    '',
    'Then give a short rationale covering: blast radius, likely regressions,',
    'security/auth/data-loss concerns, and anything a reviewer should verify.',
    'Be concise and concrete; cite filenames where relevant.',
    '',
    '## Changes under review',
    buildDiffContext(files),
  ].join('\n');
}

/**
 * Handle `/zai impact`. READ-ONLY: posts a comment, never applies labels.
 *
 * @param {object} args  `{ octokit, context, config, core, commenter, args, callApi }`
 * @param {object} [deps={}]
 * @param {(o: object) => Promise<*>} [deps.post]
 * @param {(o: object) => Promise<Array>} [deps.getChangedFiles]
 * @returns {Promise<void>}
 */
export async function handleImpactCommand(
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
    const prompt = buildImpactPrompt(files || []);
    const assessment = await callApi(config.apiKey, config.model, prompt);
    await post(assessment);
    // READ-ONLY: deliberately no `octokit.rest.issues.addLabels` here.
  } catch (error) {
    if (core?.warning) {
      core.warning(`impact handler failed: ${error?.message ?? error}`);
    }
    try {
      await post(ERROR_COMMENT);
    } catch {
      /* last-resort: never throw out of the handler. */
    }
  }
}
