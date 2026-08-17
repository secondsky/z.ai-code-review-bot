/**
 * `/zai describe` — generate a PR description.
 *
 * Fetches the PR's commits (up to ~30) and changed files, builds a prompt
 * asking for a structured description (Overview / Features / Bug Fixes /
 * Refactoring / Infra), and posts the result as a COMMENT.
 *
 * READ-ONLY by default. OPT-IN mutation gated by `ZAI_DESCRIBE_WRITE_BODY`
 * (default off): when that flag is on, the generated description is also
 * upserted into a marked block in the PR body via `pulls.update` — only the
 * marked block is ever mutated, the rest of the body is preserved verbatim.
 *
 * Contract invariants: same `deps = {}` seam; same injected `callApi`; NEVER
 * throws; no `@actions/core` import; no direct network.
 */
import { postComment, upsertPrDescription, runCommand } from './_shared.js';
import { sanitizeModelOutput } from '../sanitize-output.js';
import { wrapUntrusted } from '../prompt.js';
import { getChangedFiles } from '../changed-files.js';

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
    wrapUntrusted(
      `## Commits\n${commitLines || '(none)'}\n\n## Changed files\n${fileLines || '(none)'}`,
      'commits-and-files',
    ),
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

  // F-RUNCOMMAND: the outer never-throw scaffold (warning + ERROR_COMMENT
  // fallback post) is owned by runCommand in _shared.js.
  return runCommand('describe', { core, post }, async () => {
    const [commits, files] =
      typeof pullNumber === 'number'
        ? await Promise.all([
            listCommits({ octokit, owner, repo, pullNumber }),
            listFiles({ octokit, owner, repo, pullNumber }),
          ])
        : [[], []];

    const prompt = buildDescribePrompt({ commits, files });
    const raw = await callApi(config.apiKey, config.model, prompt);
    // Sanitize ONCE before BOTH paths (comment + body upsert). The comment
    // path would be sanitized again inside postComment (idempotent), but the
    // body-upsert path (upsertPrDescription → pulls.update) does NOT sanitize
    // — so without this, raw model output (e.g. injected @mentions or forged
    // GitHub alert banners from an indirect prompt-injection in the diff) is
    // written verbatim into the PR body under the bot's trusted identity.
    // sanitizeModelOutput also caps length at 16000, avoiding GitHub's 65536-
    // char 422 on the pulls.update call.
    const safeDescription = sanitizeModelOutput(raw);
    await post(safeDescription);
    // OPT-IN mutation: when ZAI_DESCRIBE_WRITE_BODY is true, upsert a marked
    // description block into the PR body. Only the marked block is mutated.
    // W15-A4-2: the upsert gets its OWN fail-soft try/catch. It previously
    // shared the outer catch with callApi, so a pulls.update failure posted a
    // FALSE "> ⚠️ Z.ai request failed." comment AFTER the description was
    // already posted. Per SECURITY.md's fail-soft write-surfaces contract, a
    // mutation failure only core.warning's — the description comment stays
    // the only comment.
    if (config.describeWriteBody && typeof pullNumber === 'number') {
      try {
        await upsertDescription({
          octokit,
          owner,
          repo,
          pullNumber,
          description: safeDescription,
        });
      } catch (mutationError) {
        if (core?.warning) {
          core.warning(
            `describe body upsert failed: ${mutationError?.message ?? mutationError}`,
          );
        }
      }
    }
  });
}
