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
  filterExcludedFiles,
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
  // W15-A4-3: the EMOJI forms are the canonical format the prompt requests
  // (`🔴 critical`, `🟠 high`, …), so check ALL FOUR emoji first (in severity
  // order). Only when no emoji is on the first line fall back to word-form
  // matching. The previous interleaved loop (🔴, critical, 🟠, high, …) let a
  // stray higher-severity WORD override the declared emoji: '🟡 medium — not
  // in the critical path' matched the word 'critical' first → wrong
  // zai:critical label.
  for (const key of ['🔴', '🟠', '🟡', '🟢']) {
    // Emoji keys have no word boundaries; use includes. W5-7: restrict to
    // the FIRST line (where the prompt puts the level), consistent with the
    // word-form match below. Previously `raw.includes(key)` scanned the whole
    // body, so a 🔴 appearing in the rationale overrode the declared level.
    if (firstLine.includes(key)) return SEVERITY_KEYS[key];
  }
  for (const key of ['critical', 'high', 'medium', 'low']) {
    // Word keys: negative lookbehind/lookahead for word chars AND hyphens,
    // so "highlighted" → no match, "noncritical" → no match, and
    // "high-availability" → no match (hyphen is NOT a word boundary here).
    // Only match on the FIRST line (where the prompt puts the level).
    const re = new RegExp(`(?<![\\w-])${key}(?![\\w-])`, 'i');
    if (re.test(firstLine)) return SEVERITY_KEYS[key];
  }
  return null;
}

/**
 * Build the diff context block from patchable files, capped to a char budget.
 * Pure (exported for testing).
 *
 * @param {Array<{filename: string, patch?: string}>} files
 * @param {number} [maxChars]
 * @param {string[]} [excludePatterns]  Globs to drop BEFORE the patchable
 *   filter (W16-B4-4). `undefined`/non-array → nothing is excluded (mirrors
 *   review.js: production config always carries the default exclude list).
 * @returns {string}
 */
export function buildDiffContext(
  files,
  maxChars = MAX_CONTEXT_CHARS,
  excludePatterns,
) {
  // W16-B4-4: drop excluded files (lockfiles etc.) BEFORE the patchable
  // filter, mirroring review.js's W15-A8-8 fix (identical copy of the fix in
  // ask.js's buildDiffContext). Previously a default-excluded
  // package-lock.json (typically FIRST and huge) passed filterPatchableFiles
  // and ate the ENTIRE budget — real changes were invisible to /zai impact.
  const notExcluded = filterExcludedFiles(files || [], excludePatterns);
  const patchable = filterPatchableFiles(notExcluded);
  if (patchable.length === 0) return '(no textual diffs available)';
  const lines = [];
  let used = 0;
  let skippedOversized = false;
  for (const f of patchable) {
    const entry = `### ${f.filename}\n\`\`\`diff\n${f.patch}\n\`\`\``;
    // W15-A4-4: SKIP an over-budget entry and keep scanning — the previous
    // `break` stopped at the first oversized diff, so a huge file FIRST in
    // the list caused '(no textual diffs available)' even though later,
    // smaller entries fit the budget.
    if (used + entry.length > maxChars) {
      skippedOversized = true;
      continue;
    }
    lines.push(entry);
    used += entry.length + 2;
  }
  if (lines.length === 0) {
    // Every entry was oversized (there WAS textual diff content; it just
    // didn't fit). Say the budget was exceeded rather than falsely claiming
    // no textual diffs exist.
    return skippedOversized
      ? `(diffs omitted: exceeded ${maxChars}-char budget)`
      : '(no textual diffs available)';
  }
  return lines.join('\n\n');
}

/**
 * Build the impact USER prompt. Pure (exported for testing).
 *
 * @param {Array<{filename: string, patch?: string}>} files
 * @param {string[]} [excludePatterns]  Threaded to buildDiffContext (W16-B4-4).
 * @returns {string}
 */
export function buildImpactPrompt(files, excludePatterns) {
  return [
    'Assess the impact and risk of the following pull-request changes.',
    'Begin your response with a severity level on its own first line, using',
    'one of: 🟢 low, 🟡 medium, 🟠 high, 🔴 critical.',
    '',
    'Then give a short rationale covering: blast radius, likely regressions,',
    'security/auth/data-loss concerns, and anything a reviewer should verify.',
    'Be concise and concrete; cite filenames where relevant.',
    '',
    wrapUntrusted(
      `## Changes under review\n${buildDiffContext(files, MAX_CONTEXT_CHARS, excludePatterns)}`,
      'pr-changes',
    ),
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
 * W18-D3-2: when `severity` is null (model output unparseable), the managed
 * labels from a PREVIOUS run are stale — the new assessment does not confirm
 * them. They are still removed (all of them; there is no target), and nothing
 * is added. Previously `if (!severity) return false;` bailed before the
 * removal loop, leaving e.g. a stale zai:high on the PR forever.
 *
 * W19-E2-3: that null-severity removal is now restricted to the bot's
 * DEFAULT-managed `zai:` namespace ONLY. With a custom flat map (P0..P3) the
 * bot cannot prove it applied a label — removing a human triager's P2 on an
 * unparseable assessment was destructive mutation of labels the bot never
 * owned (the documented contract says human labels are never touched). Under
 * a custom map nothing is removed and `core.warning` explains why; under the
 * default `zai:` scheme the W18-D3-2 cleanup is preserved byte-for-byte.
 *
 * Injected via deps so tests never touch the GitHub API.
 *
 * @param {object} args `{ octokit, owner, repo, issueNumber, severity, labelMap, core? }`
 * @returns {Promise<boolean>} true if a label was applied, false otherwise.
 */
async function defaultApplyLabel({ octokit, owner, repo, issueNumber, severity, labelMap, core }) {
  const targetLabel = severity ? labelMap?.[severity] : null;

  // Fetch current labels and remove any existing managed labels (idempotent).
  // A label is "managed" if it appears as a value in the labelMap; this is
  // shape-agnostic (works for `zai:*` prefixes AND flat value sets like P0/P1).
  const { data: current } = await octokit.rest.issues.listLabelsOnIssue({
    owner,
    repo,
    issue_number: issueNumber,
  });
  const managed = new Set(Object.values(labelMap || {}));
  // W19-E2-3: with a null severity there is no target. Only `zai:`-prefixed
  // managed labels (the bot's default-managed namespace) are removed; a
  // managed label under a CUSTOM map may have been applied by a human triager
  // and is left strictly alone (declined via core.warning below).
  let declinedUnparsedManaged = false;
  for (const label of current) {
    const name = label?.name ?? '';
    if (!managed.has(name) || name === targetLabel) continue;
    if (severity == null && !name.startsWith('zai:')) {
      declinedUnparsedManaged = true;
      continue;
    }
    try {
      await octokit.rest.issues.removeLabel({ owner, repo, issue_number: issueNumber, name });
    } catch {
      // A label may already be gone; ignore.
    }
  }
  if (declinedUnparsedManaged && core?.warning) {
    core.warning(
      'impact: assessment unparseable; leaving labels unchanged ' +
        '(cannot prove the bot applied non-zai: labels)',
    );
  }
  // Nothing to add when the severity is null (unparseable) or unmappable —
  // the stale-label cleanup above is the whole job.
  if (!targetLabel) return false;
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
    const prompt = buildImpactPrompt(files || [], config.excludePatterns);
    const assessment = await callApi(config.apiKey, config.model, prompt);
    await post(assessment);
    // OPT-IN mutation: when ZAI_IMPACT_LABELS is true, apply a scoped zai:
    // severity label (removing prior zai: labels for idempotency).
    // W15-A4-2: the label application gets its OWN fail-soft try/catch. It
    // previously shared the outer catch with callApi, so an addLabels
    // failure posted a FALSE "> ⚠️ Z.ai request failed." comment AFTER the
    // assessment was already posted. Per SECURITY.md's fail-soft
    // write-surfaces contract, a mutation failure only core.warning's — the
    // assessment comment stays the only comment.
    if (config.impactLabels && typeof pullNumber === 'number') {
      try {
        const severity = parseSeverity(assessment);
        await applyLabel({
          octokit,
          owner,
          repo,
          issueNumber: pullNumber,
          severity,
          labelMap: config.impactLabelMap,
          // W19-E2-3: the default applyLabel warns when an unparseable
          // assessment declines to touch custom-map labels.
          core,
        });
      } catch (mutationError) {
        if (core?.warning) {
          core.warning(
            `impact label application failed: ${mutationError?.message ?? mutationError}`,
          );
        }
      }
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
