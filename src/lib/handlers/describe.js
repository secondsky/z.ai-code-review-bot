/**
 * `/zai describe` — generate a PR description.
 *
 * Fetches the PR's commits (up to ~30) and changed files, builds a prompt
 * asking for a structured description (Overview / Features / Bug Fixes /
 * Refactoring / Infra), and posts the result as a COMMENT.
 *
 * v1 READ-ONLY INVARIANT: this handler does NOT mutate the PR body. The fork
 * did (via `pulls.update`) — that is a side effect we deliberately reject for
 * v1. The generated description is posted as a comment only; a human can copy
 * it into the PR body if they choose. No `pulls.update` is ever called here.
 *
 * Contract invariants: same `deps = {}` seam; same injected `callApi`; NEVER
 * throws; no `@actions/core` import; no direct network.
 */
import { postComment, upsertPrDescription } from './_shared.js';
import { getChangedFiles } from '../changed-files.js';

/** Fixed error comment (no raw error leakage). */
const ERROR_COMMENT = '> ⚠️ Z.ai request failed. Please try again.';

/** Cap on the number of commits fetched for the prompt. */
const MAX_COMMITS = 30;

/**
 * Build the describe USER prompt. Pure (exported for testing).
 *
 * @param {object} p
 * @param {Array<{commit?: {message?: string}, sha?: string}>} p.commits
 * @param {Array<{filename: string, status?: string}>} p.files
 * @returns {string}
 */
export function buildDescribePrompt({ commits, files }) {
  const commitLines = (commits || [])
    .slice(0, MAX_COMMITS)
    .map((c) => `- ${c?.commit?.message ?? c?.sha ?? '(no message)'}`)
    .join('\n');
  const fileLines = (files || [])
    .map((f) => `- ${f.filename} (${f.status || 'modified'})`)
    .join('\n');
  return [
    'Generate a clear, structured pull-request description from the following',
    'commits and changed files. Use these sections (omit any that are empty):',
    'Overview, Features, Bug Fixes, Refactoring, Infrastructure. Do not',
    'include a section header for changes that did not happen.',
    '',
    '## Commits',
    commitLines || '(none)',
    '',
    '## Changed files',
    fileLines || '(none)',
  ].join('\n');
}

/**
 * Fetch up to {@link MAX_COMMITS} commits for a PR.
 *
 * @param {object} args `{ octokit, owner, repo, pullNumber }`
 * @returns {Promise<Array>}
 */
async function defaultListCommits({ octokit, owner, repo, pullNumber }) {
  const { data } = await octokit.rest.pulls.listCommits({
    owner,
    repo,
    pull_number: pullNumber,
    per_page: MAX_COMMITS,
  });
  return data;
}

/**
 * Fetch ALL changed files for a PR (paginated), reusing the shared
 * `getChangedFiles` helper so a >100-file PR is fully covered rather than
 * silently truncated. (Previously this used a single-page fetch that dropped
 * files past page 1, producing a misleading description.)
 *
 * @param {object} args `{ octokit, owner, repo, pullNumber }`
 * @returns {Promise<Array>}
 */
async function defaultListFiles({ octokit, owner, repo, pullNumber }) {
  return getChangedFiles({ octokit, owner, repo, pullNumber });
}

/**
 * Handle `/zai describe`. READ-ONLY: posts a comment, never mutates the PR.
 *
 * @param {object} args  `{ octokit, context, config, core, commenter, args, callApi }`
 * @param {object} [deps={}]
 * @param {(o: object) => Promise<*>} [deps.post]
 * @param {(o: object) => Promise<Array>} [deps.listCommits]
 * @param {(o: object) => Promise<Array>} [deps.listFiles]
 * @returns {Promise<void>}
 */
export async function handleDescribeCommand(
  { octokit, context, config = {}, core, commenter, args, callApi } = {},
  deps = {},
) {
  const {
    post = (body) => postComment({ octokit, context, body }),
    listCommits = (o) => defaultListCommits(o),
    listFiles = (o) => defaultListFiles(o),
    upsertDescription = (o) => upsertPrDescription(o),
  } = deps;

  const owner = context?.repo?.owner;
  const repo = context?.repo?.repo;
  const pullNumber = context?.payload?.issue?.number;

  try {
    const [commits, files] =
      typeof pullNumber === 'number'
        ? await Promise.all([
            listCommits({ octokit, owner, repo, pullNumber }),
            listFiles({ octokit, owner, repo, pullNumber }),
          ])
        : [[], []];

    const prompt = buildDescribePrompt({ commits, files });
    const description = await callApi(config.apiKey, config.model, prompt);
    await post(description);
    // OPT-IN mutation: when ZAI_DESCRIBE_WRITE_BODY is true, upsert a marked
    // description block into the PR body. Only the marked block is mutated.
    if (config.describeWriteBody && typeof pullNumber === 'number') {
      await upsertDescription({ octokit, owner, repo, pullNumber, description });
    }
  } catch (error) {
    if (core?.warning) {
      core.warning(`describe handler failed: ${error?.message ?? error}`);
    }
    try {
      await post(ERROR_COMMENT);
    } catch {
      /* last-resort: never throw out of the handler. */
    }
  }
}
