/**
 * Handler registry: the map of `/zai` command → handler function.
 *
 * This is the single object the router (src/index.js) injects as
 * `deps.handlers` (Task 9). Each handler shares the same contract:
 *
 *   `handler({ octokit, context, config, core, commenter, args, callApi }, deps = {})`
 *
 * Handlers NEVER throw (errors become a short comment + return), use the same
 * injected `callApi(apiKey, model, userPrompt)`, and never import
 * `@actions/core` or hit the network directly.
 *
 * READ-ONLY by default. `describe` and `impact` have OPT-IN mutations, each
 * gated by an action input that defaults to OFF:
 *   - `ZAI_DESCRIBE_WRITE_BODY: true`  → describe upserts a marked PR-body block.
 *   - `ZAI_IMPACT_LABELS: true`         → impact applies a zai: severity label.
 */
import { handleAskCommand } from './ask.js';
import { handleHelpCommand } from './help.js';
import { handleReviewCommand } from './review.js';
import { handleExplainCommand } from './explain.js';
import { handleDescribeCommand } from './describe.js';
import { handleImpactCommand } from './impact.js';

export const HANDLERS = {
  ask: handleAskCommand,
  help: handleHelpCommand,
  review: handleReviewCommand,
  explain: handleExplainCommand,
  describe: handleDescribeCommand,
  impact: handleImpactCommand,
};
