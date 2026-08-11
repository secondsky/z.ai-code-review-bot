/**
 * `/zai impact` — assess the change's impact/risk.
 *
 * Fetches the changed files (+patches, capped), builds a prompt asking for a
 * risk assessment with a severity level (🟢 low / 🟡 medium / 🟠 high / 🔴
 * critical) and rationale, and posts the result as a COMMENT.
 *
 * READ-ONLY by default. OPT-IN mutation gated by `ZAI_IMPACT_LABELS`
 * (default off): when that flag is on, a severity label (mapped via
 * `ZAI_IMPACT_LABEL_MAP`) is applied to the PR via `issues.addLabels`, and any
 * prior managed label is removed for idempotency.
 *
 * Contract invariants: same `deps = {}` seam; same injected `callApi`; NEVER
 * throws; no `@actions/core` import; no direct network.
 */
import { postComment } from './_shared.js';
import { wrapUntrusted } from '../prompt.js';
import {
  getChangedFiles,
  filterPatchableFiles,
} from '../changed-files.js';

/** Fixed error comment (no raw error leakage). */
const ERROR_COMMENT = '> ⚠️ Z.ai request failed. Please try again.';

/** Cap on the diff context bundled into the prompt. */
const MAX_CONTEXT_CHARS = 8000;

/**
 * Emoji → severity-key map, matching the prompt's requested severity prefix
 * (buildImpactPrompt asks for `🔴 critical`, `🟠 high`, `🟡 medium`, `🟢 low`).
 * Used by parseSeverity when ZAI_IMPACT_LABELS is enabled.
 */
const SEVERITY_KEYS = {
  '🔴': 'critical',
  '🟠': 'high',
  '🟡': 'medium',
  '🟢': 'low',
  // Word-form fallback (in case the model emits the word without the emoji).
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
};

/**
 * Extract the severity from the model's impact assessment. The prompt asks for
 * a severity level on its own first line; this parses the first severity
 * keyword or emoji found on that first line ONLY. Pure (exported for testing).
 *
 * Word-form keys (critical/high/medium/low) are matched with negative
 * lookbehind/lookahead for word chars AND hyphens, so "highlighted" no longer
 * matches "high", "noncritical" no longer matches "critical", and
 * "high-availability" no longer matches "high" (a hyphen is NOT treated as a
 * word boundary). Common negation prefixes ("non-critical", "not critical",
 * "no critical issues", "isn't high") are stripped before matching so a
 * negated severity word does not false-positive. Emoji keys have no word
 * boundaries, so they still use `includes`.
 *
 * Only the FIRST line is consulted for word-form matches — the prompt puts the
 * severity level on its own first line, and severity words appearing in the
 * rationale body (e.g. "high confidence", "high-availability") must NOT
 * override the declared level.
 *
 * @param {string} text  The model's assessment output.
 * @returns {'critical'|'high'|'medium'|'low'|null}
 */
export function parseSeverity(text) {
  const raw = String(text ?? '');
  // Remove negated severity phrases entirely so "non-critical", "not critical",
  // "no critical issues", "isn't high risk" don't false-positive. We match
  // common negators followed by an optional separator and the severity word,
  // replacing the whole phrase with a neutral placeholder.
  const SEV_WORDS = 'critical|high|medium|low';
  const NEGATED_RE = new RegExp(
    `\\b(?:non-|not\\s+|no\\s+|isn'?t\\s+|aren'?t\\s+|without\\s+)\\s*(?:${SEV_WORDS})\\b`,
    'gi',
  );
  const cleaned = raw.replace(NEGATED_RE, 'neutral');
  const firstLine = cleaned.split('\n')[0];
  // Check emoji + word forms in priority order (critical first).
  for (const key of ['🔴', 'critical', '🟠', 'high', '🟡', 'medium', '🟢', 'low']) {
    const mapped = SEVERITY_KEYS[key];
    if (!mapped) continue;
    if (/[\u{1F300}-\u{1FAFF}]/u.test(key)) {
      // Emoji keys have no word boundaries; use includes. W5-7: restrict to
      // the FIRST line (where the prompt puts the level), consistent with the
      // word-form match below. Previously `raw.includes(key)` scanned the whole
      // body, so a 🔴 appearing in the rationale overrode the declared level.
      if (firstLine.includes(key)) return mapped;
    } else {
      // Word keys: negative lookbehind/lookahead for word chars AND hyphens,
      // so "highlighted" → no match, "noncritical" → no match, and
      // "high-availability" → no match (hyphen is NOT a word boundary here).
      // Only match on the FIRST line (where the prompt puts the level).
      const re = new RegExp(`(?<![\\w-])${key}(?![\\w-])`, 'i');
      if (re.test(firstLine)) return mapped;
    }
  }
  return null;
}

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
    wrapUntrusted(`## Changes under review\n${buildDiffContext(files)}`, 'pr-changes'),
  ].join('\n');
}

/**
 * Apply (or replace) the severity label on the issue. ALL labels whose name
 * appears as a value in the configured `labelMap` are considered "managed":
 * any existing managed label (other than the target) is removed and the new
 * one is set, so re-runs are idempotent and human labels are never touched.
 * This works for any label-map shape — `zai:`-prefixed maps AND flat value
 * sets like `{ critical: 'P0', high: 'P1', ... }`.
 *
 * Injected via deps so tests never touch the GitHub API.
 *
 * @param {object} args `{ octokit, owner, repo, issueNumber, severity, labelMap }`
 * @returns {Promise<boolean>} true if a label was applied, false if unmappable.
 */
async function defaultApplyLabel({ octokit, owner, repo, issueNumber, severity, labelMap }) {
  if (!severity) return false;
  const targetLabel = labelMap?.[severity];
  if (!targetLabel) return false;

  // Fetch current labels and remove any existing managed labels (idempotent).
  // A label is "managed" if it appears as a value in the labelMap; this is
  // shape-agnostic (works for `zai:*` prefixes AND flat value sets like P0/P1).
  const { data: current } = await octokit.rest.issues.listLabelsOnIssue({
    owner,
    repo,
    issue_number: issueNumber,
  });
  const managed = new Set(Object.values(labelMap || {}));
  for (const label of current) {
    const name = label?.name ?? '';
    if (managed.has(name) && name !== targetLabel) {
      try {
        await octokit.rest.issues.removeLabel({ owner, repo, issue_number: issueNumber, name });
      } catch {
        // A label may already be gone; ignore.
      }
    }
  }
  await octokit.rest.issues.addLabels({
    owner,
    repo,
    issue_number: issueNumber,
    labels: [targetLabel],
  });
  return true;
}

/**
 * Handle `/zai impact`. READ-ONLY by default: posts a comment, never applies
 * labels. When ZAI_IMPACT_LABELS is true (opt-in), applies a `zai:`-scoped
 * severity label based on the model's assessment.
 *
 * @param {object} args  `{ octokit, context, config, core, commenter, args, callApi }`
 * @param {object} [deps={}]
 * @param {(o: object) => Promise<*>} [deps.post]
 * @param {(o: object) => Promise<Array>} [deps.getChangedFiles]
 * @param {(o: object) => Promise<boolean>} [deps.applyLabel]
 * @returns {Promise<void>}
 */
export async function handleImpactCommand(
  { octokit, context, config = {}, core, commenter, args, callApi } = {},
  deps = {},
) {
  const {
    post = (body) => postComment({ octokit, context, body }),
    getChangedFiles: getFiles = (o) => getChangedFiles(o),
    applyLabel = (o) => defaultApplyLabel(o),
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
    // OPT-IN mutation: when ZAI_IMPACT_LABELS is true, apply a scoped zai:
    // severity label (removing prior zai: labels for idempotency).
    if (config.impactLabels && typeof pullNumber === 'number') {
      const severity = parseSeverity(assessment);
      await applyLabel({
        octokit,
        owner,
        repo,
        issueNumber: pullNumber,
        severity,
        labelMap: config.impactLabelMap,
      });
    }
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
