/**
 * Inline line-level review comments (v2 headline feature).
 *
 * Builds and submits GitHub reviews whose inline comments are anchored to diff
 * lines — the CodeRabbit/Copilot experience. Replaces the single summary
 * comment for the PR auto-review path when findings are line-mappable.
 *
 * This module does I/O via an injected `octokit` (so tests pass a fake). The
 * pure builders ({@link buildReviewBody}, {@link buildReviewComments},
 * {@link buildReviewPayload}) have no I/O and are unit-tested directly.
 *
 * Idempotency model (mirrors `comments.js`): the review body carries the
 * {@link MARKER} HTML comment. On each run, {@link upsertReview} lists prior
 * reviews whose body includes the marker, DISMISSES them (so stale inline
 * comments disappear on re-push), then creates the fresh review. This
 * "dismiss-stale-then-post" sequence keeps exactly one active bot review per
 * PR head SHA without piling up duplicates.
 *
 * @module src/lib/review.js
 */

import { MARKER } from './comments.js';
import { sanitizeModelOutput, sanitizeCommentBody } from './sanitize-output.js';
import { postComment } from './handlers/_shared.js';
import { formatWalkthroughSummary } from './walkthrough.js';

/**
 * Per-severity emoji for inline comment bodies. Mirrors the table in
 * findings.js so the inline comments and the summary stay visually consistent.
 */
const SEVERITY_EMOJI = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🔵',
  info: '➖',
};

/**
 * Build the review body (the top-level prose shown on the review).
 *
 * Structure:
 *   ## <reviewerName>            (when reviewerName provided)
 *   <optional deterministic-findings note>
 *   <optional truncation note>
 *   <summary prose>
 *   <if summaryOnly non-empty>:
 *     <if metadata.walkthrough && metadata.files>:
 *       Cohort-ordered walkthrough sections (collapsible <details>) for the
 *       summary-only findings — renders the same overview + cohort sections as
 *       formatWalkthroughSummary, minus the trailing marker (the body adds its
 *       own marker once at the very end).
 *     <else>:
 *   ## Additional findings
 *   - **file** — title           (one per summary-only finding)
 *     <endif>
 *   <endif>
 *   <!-- zai-code-review -->     (byte-exact marker — REQUIRED for idempotency)
 *
 * The walkthrough path reuses formatWalkthroughSummary but strips its header +
 * trailing marker so the body keeps a single header (## reviewerName) and a
 * single trailing marker. This keeps the summary-only findings grouped by
 * dependency-ordered cohort — the inline comments stay line-anchored and
 * unaffected.
 *
 * @param {string} summary - the model's prose summary
 * @param {Array<{file?:string, title?:string}>} summaryOnlyFindings - findings that couldn't map to lines
 * @param {{reviewerName?:string, deterministicFindingsCount?:number, truncated?:number, walkthrough?:boolean, files?:Array, summary?:string, suggestedReviewersLine?:string}} [metadata]
 * @returns {string}
 */
export function buildReviewBody(summary, summaryOnlyFindings, metadata = {}) {
  const lines = [];
  const reviewerName =
    typeof metadata.reviewerName === 'string' && metadata.reviewerName.length > 0
      ? metadata.reviewerName
      : null;
  if (reviewerName) {
    lines.push(`## ${reviewerName}`);
    lines.push('');
  }

  const detCount = typeof metadata.deterministicFindingsCount === 'number' ? metadata.deterministicFindingsCount : 0;
  if (detCount > 0) {
    lines.push(`🔍 Scanners found ${detCount} deterministic issues.`);
    lines.push('');
  }
  const truncated = typeof metadata.truncated === 'number' ? metadata.truncated : 0;
  if (truncated > 0) {
    lines.push(`_${truncated} findings truncated to cap._`);
    lines.push('');
  }
  // Phase 8.1: optional pre-rendered "Suggested reviewers" line (CODEOWNERS).
  const suggestedReviewersLine =
    typeof metadata.suggestedReviewersLine === 'string' ? metadata.suggestedReviewersLine : '';
  if (suggestedReviewersLine.length > 0) {
    lines.push(suggestedReviewersLine);
    lines.push('');
  }

  if (typeof summary === 'string' && summary.length > 0) {
    lines.push(summary);
    lines.push('');
  }

  const summaryOnly = Array.isArray(summaryOnlyFindings) ? summaryOnlyFindings : [];
  if (summaryOnly.length > 0) {
    const useWalkthrough =
      metadata.walkthrough === true && Array.isArray(metadata.files);

    if (useWalkthrough) {
      // Render the summary-only findings as a dependency-ordered walkthrough.
      // Strip the walkthrough's own header (## reviewerName) and trailing marker
      // so the review body retains exactly one header and one marker.
      const rendered = formatWalkthroughSummary(summaryOnly, metadata.files, {
        reviewerName: reviewerName ?? 'Z.ai Code Review',
        metadata: { summary: '' },
      });
      // Drop the leading "## <name>\n\n" header.
      let body = rendered;
      const headerEnd = body.indexOf('\n\n');
      if (headerEnd !== -1) body = body.slice(headerEnd + 2);
      // Drop the trailing "\n<!-- zai-code-review -->" — keep everything up to
      // (but not including) the final marker line.
      const markerIdx = body.lastIndexOf(MARKER);
      if (markerIdx !== -1) {
        body = body.slice(0, markerIdx).replace(/\n+$/, '');
      }
      lines.push(body);
      lines.push('');
    } else {
      lines.push('## Additional findings');
      lines.push('');
      for (const f of summaryOnly) {
        const file = typeof f?.file === 'string' ? f.file : '';
        const title = typeof f?.title === 'string' ? f.title : '';
        // W6-4: filenames are attacker-controlled — render as inline code so
        // markdown metacharacters in a filename cannot inject formatting/links.
        lines.push(`- \`${file}\` — ${title}`);
      }
      lines.push('');
    }
  }

  lines.push(MARKER);
  // Sanitize the assembled body: the model's `summary` prose and the
  // summary-only finding titles are untrusted model output that could carry
  // @mention spam or GitHub alert banners. sanitizeCommentBody preserves the
  // leading `## Title` header and the trailing byte-exact MARKER while
  // neutralizing @mentions and alert banners in the content between them.
  return sanitizeCommentBody(lines.join('\n'));
}

/**
 * Render a single inline comment body from a finding.
 *
 * Format:
 *   <emoji> **<title>**
 *   <description>
 *   > `<evidence>`        (when evidence present)
 *   💡 <suggestion>       (when suggestion present)
 *
 * The whole body is run through `sanitizeModelOutput` before returning so an
 * indirect prompt-injection in the diff cannot coax @mention spam or forged
 * alert banners into the bot's trusted review comments.
 *
 * @param {Record<string, unknown>} finding
 * @returns {string}
 */
function renderCommentBody(finding) {
  const severity = typeof finding.severity === 'string' ? finding.severity : 'info';
  const emoji = SEVERITY_EMOJI[severity] ?? '➖';
  // CORE-2: collapse newlines in title/description/suggestion so model output
  // carrying stray newlines can't break the markdown structure or inject
  // unescaped markdown (e.g. a newline mid-title would split the bold span).
  const stripNewlines = (s) => String(s).replace(/\r?\n/g, ' ');
  const title =
    typeof finding.title === 'string' ? stripNewlines(finding.title) : '';
  const description =
    typeof finding.description === 'string' ? stripNewlines(finding.description) : '';
  const evidence = typeof finding.evidence === 'string' ? finding.evidence : '';
  const suggestion =
    typeof finding.suggestion === 'string' && finding.suggestion.length > 0
      ? stripNewlines(finding.suggestion)
      : null;

  const parts = [];
  parts.push(`${emoji} **${title}**`);
  if (description.length > 0) parts.push(description);
  if (evidence.length > 0) {
    // CORE-2: escape backticks AND collapse newlines in evidence so the inline
    // code span is preserved. A newline would close the span early and let the
    // remaining content render as markdown (e.g. a clickable malicious link).
    const safeEvidence = evidence.replace(/`/g, '\\`').replace(/\r?\n/g, ' ');
    parts.push(`> \`${safeEvidence}\``);
  }
  if (suggestion !== null) parts.push(`💡 ${suggestion}`);
  return sanitizeModelOutput(parts.join('\n'));
}

/**
 * Build the comments array for the GitHub review payload.
 *
 * Each comment is `{ path, line, side: 'RIGHT', body }`. The bodies are
 * rendered from each finding via {@link renderCommentBody} (which sanitizes).
 *
 * @param {Array<{finding:object, comment:{path:string, line:number, side:string}}>} inlineFindings
 * @returns {Array<{path:string, line:number, side:string, body:string}>}
 */
export function buildReviewComments(inlineFindings) {
  if (!Array.isArray(inlineFindings)) return [];
  return inlineFindings.map(({ finding, comment }) => ({
    path: comment.path,
    line: comment.line,
    side: comment.side,
    body: renderCommentBody(finding),
  }));
}

/**
 * Assemble the full `pulls.createReview` payload.
 *
 * `event` defaults to `'COMMENT'` (advisory review). In strict mode (Phase
 * 8.3) a caller passes `'REQUEST_CHANGES'` (resolved via {@link
 * resolveReviewEvent}) to block merge until the requesting review is
 * dismissed or the changes are addressed.
 *
 * @param {{body:string, comments:Array, event?:string}} opts
 * @returns {{body:string, event:string, comments:Array}}
 */
export function buildReviewPayload({ body, comments, event } = {}) {
  return {
    body: String(body ?? ''),
    event: typeof event === 'string' && event.length > 0 ? event : 'COMMENT',
    comments: Array.isArray(comments) ? comments : [],
  };
}

/**
 * The set of finding severities that — when present alongside a strict-mode
 * config — escalate the review event from advisory (`COMMENT`) to blocking
 * (`REQUEST_CHANGES`). Only `critical` and `high` qualify; medium/low/info
 * stay advisory even under strict mode.
 * @type {ReadonlySet<string>}
 */
const STRICT_SEVERITIES = new Set(['critical', 'high']);

/**
 * Decide which GitHub review `event` to submit: advisory `'COMMENT'` (default)
 * or blocking `'REQUEST_CHANGES'` (strict mode).
 *
 * Strict mode is OFF by default and NEVER auto-enabled — it only fires when
 * `config.strictMode === true`. When strict mode is on, the review escalates
 * to `REQUEST_CHANGES` ONLY if at least one finding has severity `critical`
 * or `high`. Lower severities (medium/low/info) and empty/unknown findings
 * never trigger a block.
 *
 * `REQUEST_CHANGES` is a GitHub review state that blocks merge until the
 * requesting review is dismissed or the changes are addressed — it is
 * powerful, so this function is deliberately conservative: every condition
 * must hold (explicit opt-in + a critical/high finding) for it to fire.
 *
 * @param {Array<{severity?:string}>} findings - the ranked/capped findings.
 * @param {{strictMode?:boolean}} config - the merged config object.
 * @returns {'COMMENT' | 'REQUEST_CHANGES'}
 */
export function resolveReviewEvent(findings, config) {
  if (!config || config.strictMode !== true) return 'COMMENT';
  if (!Array.isArray(findings)) return 'COMMENT';
  for (const f of findings) {
    const sev = f && typeof f.severity === 'string' ? f.severity : '';
    if (STRICT_SEVERITIES.has(sev)) return 'REQUEST_CHANGES';
  }
  return 'COMMENT';
}

/**
 * Hard cap on pagination depth for {@link listBotReviews}. Defense-in-depth
 * (CORE-4): the loop already terminates on a short page, but a misbehaving
 * endpoint that always returns full pages would loop forever. 100 pages × 100
 * per page = 10,000 reviews — far beyond any real PR's review history.
 */
const MAX_REVIEW_PAGES = 100;

/**
 * List prior reviews posted by the bot on a PR.
 *
 * Paginates `octokit.rest.pulls.listReviews` (per_page=100, loop until a short
 * page). Filters to reviews whose `body` includes `marker`. The marker is the
 * canonical idempotency signal — every review this action posts carries it —
 * so the broad `[bot]`-login fallback that previously matched ANY bot (e.g.
 * dependabot, github-actions) was removed to avoid dismissing reviews this
 * action never posted (CORE-3).
 *
 * CORE-4: pagination is also capped at {@link MAX_REVIEW_PAGES} as a safety
 * net against a misbehaving endpoint that never returns a short page.
 *
 * @param {{octokit:object, context:object, marker?:string}} args
 * @returns {Promise<Array<{id:number, body?:string, user?:{login?:string}}>>}
 */
export async function listBotReviews({ octokit, context, marker = MARKER }) {
  const owner = context?.repo?.owner;
  const repo = context?.repo?.repo;
  const pullNumber = context?.payload?.pull_request?.number;
  if (!owner || !repo || typeof pullNumber !== 'number') return [];

  /** @type {Array} */
  const all = [];
  const perPage = 100;
  for (let page = 1; page <= MAX_REVIEW_PAGES; page++) {
    const { data } = await octokit.rest.pulls.listReviews({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: perPage,
      page,
    });
    const rows = Array.isArray(data) ? data : [];
    all.push(...rows);
    if (rows.length < perPage) break; // short page → done
  }

  return all.filter((r) => {
    const body = typeof r?.body === 'string' ? r.body : '';
    // CORE-3: the marker is the canonical idempotency signal. The previous
    // `|| login.endsWith('[bot]')` OR matched ANY bot review (including
    // dependabot, github-actions, etc.), causing upsertReview to dismiss
    // reviews this action never posted. The marker alone is sufficient for
    // idempotency (every review we post carries it).
    return body.includes(marker);
  });
}

/**
 * Dismiss prior bot reviews so stale inline comments don't pile up on re-push.
 *
 * For each review, calls `pulls.dismissReview` with `message: reason`. Tolerates
 * individual dismiss failures (an already-dismissed review returns 422) by
 * logging a warning and continuing — one stale dismissal must not abort the
 * whole re-review.
 *
 * @param {{octokit:object, context:object, reviews:Array, reason:string, core?:{warning?:Function, info?:Function}}} args
 * @returns {Promise<void>}
 */
export async function dismissStaleReviews({ octokit, context, reviews, reason, core }) {
  const owner = context?.repo?.owner;
  const repo = context?.repo?.repo;
  const pullNumber = context?.payload?.pull_request?.number;
  if (!owner || !repo || typeof pullNumber !== 'number') return;
  if (!Array.isArray(reviews)) return;

  for (const review of reviews) {
    const reviewId = review?.id;
    if (reviewId === undefined || reviewId === null) continue;
    try {
      await octokit.rest.pulls.dismissReview({
        owner,
        repo,
        pull_number: pullNumber,
        review_id: reviewId,
        message: reason,
      });
    } catch (err) {
      // A 422 usually means the review is already dismissed — tolerate it.
      if (core?.warning) {
        core.warning(
          `Failed to dismiss review ${reviewId}: ${err?.message ?? String(err)}`,
        );
      }
    }
  }
}

/**
 * Post a review with inline comments. Idempotent per SHA: dismisses prior bot
 * reviews first, then creates the new one.
 *
 * Flow:
 *   1. `listBotReviews` → prior reviews (matched by marker in body).
 *   2. `dismissStaleReviews` with `message: "Superseded by re-review at <sha>"`.
 *   3. `pulls.createReview({owner, repo, pull_number, body, event, comments})`.
 *
 * Returns `{ id, commentCount, dismissedCount }`.
 *
 * @param {{octokit:object, context:object, marker?:string, sha:string, body:string, comments:Array, event?:string, core?:object}} args
 * @returns {Promise<{id:number, commentCount:number, dismissedCount:number}>}
 */
export async function upsertReview({ octokit, context, marker = MARKER, sha, body, comments, event, core }) {
  const owner = context?.repo?.owner;
  const repo = context?.repo?.repo;
  const pullNumber = context?.payload?.pull_request?.number;

  const prior = await listBotReviews({ octokit, context, marker });
  const reason = `Superseded by re-review at ${sha ?? ''}`.trim();
  await dismissStaleReviews({ octokit, context, reviews: prior, reason, core });

  const payload = buildReviewPayload({ body, comments, event });
  const { data } = await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: pullNumber,
    body: payload.body,
    event: payload.event,
    comments: payload.comments,
  });

  return {
    id: data?.id,
    commentCount: payload.comments.length,
    dismissedCount: prior.length,
  };
}

/**
 * Post a fallback issue comment when review submission fails (all findings
 * unmappable, API error, etc.). Delegates to the existing `postComment` from
 * `handlers/_shared.js` (which already sanitizes). This ensures the review is
 * NEVER silently lost.
 *
 * @param {{octokit:object, context:object, body:string}} args
 * @returns {Promise<object|null>}  The created comment data, or null.
 */
export async function postFallbackComment({ octokit, context, body }) {
  return postComment({ octokit, context, body });
}
