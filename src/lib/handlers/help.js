/**
 * `/zai help` — static help text.
 *
 * Simplest handler: no callApi, no PR context, no network beyond posting one
 * comment. Renders a markdown table of the commands from {@link ALLOWED_COMMANDS}
 * with one-line descriptions.
 *
 * Like every handler, it uses the shared `deps = {}` DI seam and NEVER throws
 * (errors become a short comment + return, logged via `core.warning` if core
 * is present). No `@actions/core` import; no direct network.
 */
import { ALLOWED_COMMANDS } from '../commands.js';
import { postComment } from './_shared.js';

/** One-line description per command (verbatim from the task brief). */
const DESCRIPTIONS = {
  ask: 'Ask a question about the PR',
  review: 'Review a specific file (or the whole PR if no arg)',
  explain: 'Explain a line range (e.g. /zai explain 10-20)',
  describe: 'Generate a PR description',
  impact: "Assess the change's impact/risk",
  help: 'Show this help',
};

/**
 * Build the help-text comment body: a markdown table of commands.
 *
 * Pure (exported for testing). Iterates {@link ALLOWED_COMMANDS} so the table
 * stays in sync with the parser's allowlist.
 *
 * @returns {string}
 */
export function buildHelpBody() {
  const header = '| Command | Description |\n| --- | --- |';
  const rows = ALLOWED_COMMANDS.map(
    (c) => `| \`/zai ${c}\` | ${DESCRIPTIONS[c] ?? ''} |`,
  ).join('\n');
  return `## Z.ai Commands\n\n${header}\n${rows}`;
}

/**
 * Handle `/zai help`: post the static command table as a comment.
 *
 * @param {object} args  `{ octokit, context, config, core, commenter, args, callApi }`
 * @param {object} [deps={}]
 * @param {(body: string) => Promise<*>} [deps.post]
 * @returns {Promise<void>}
 */
export async function handleHelpCommand(
  { octokit, context, core } = {},
  deps = {},
) {
  const { post = (body) => postComment({ octokit, context, body }) } = deps;
  try {
    await post(buildHelpBody());
  } catch (error) {
    if (core?.warning) {
      core.warning(`help handler failed: ${error?.message ?? error}`);
    }
  }
}
