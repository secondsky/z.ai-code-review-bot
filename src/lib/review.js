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
 * bot reviews (matched by marker OR bot login), DISMISSES them (so stale
 * inline comments disappear on re-push), then creates the fresh review. This
 * "dismiss-stale-then-post" sequence keeps exactly one active bot review per
 * PR head SHA without piling up duplicates.
 *
 * @module src/lib/review.js
 */

import { MARKER } from './comments.js';
import { sanitizeModelOutput } from './sanitize-output.js';
import { postComment } from './handlers/_shared.js';

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
 *   ## Additional findings
 *   - **file** — title           (one per summary-only finding)
 *   <endif>
 *   <!-- zai-code-review -->     (byte-exact marker — REQUIRED for idempotency)
 *
 * @param {string} summary - the model's prose summary
 * @param {Array<{file?:string, title?:string}>} summaryOnlyFindings - findings that couldn't map to lines
 * @param {{reviewerName?:string, deterministicFindingsCount?:number, truncated?:number}} [metadata]
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

  if (typeof summary === 'string' && summary.length > 0) {
    lines.push(summary);
    lines.push('');
  }

  const summaryOnly = Array.isArray(summaryOnlyFindings) ? summaryOnlyFindings : [];
  if (summaryOnly.length > 0) {
    lines.push('## Additional findings');
    lines.push('');
    for (const f of summaryOnly) {
      const file = typeof f?.file === 'string' ? f.file : '';
      const title = typeof f?.title === 'string' ? f.title : '';
      lines.push(`- **${file}** — ${title}`);
    }
    lines.push('');
  }

  lines.push(MARKER);
  return lines.join('\n');
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
  const title = typeof finding.title === 'string' ? finding.title : '';
  const description = typeof finding.description === 'string' ? finding.description : '';
  const evidence = typeof finding.evidence === 'string' ? finding.evidence : '';
  const suggestion =
    typeof finding.suggestion === 'string' && finding.suggestion.length > 0 ? finding.suggestion : null;

  const parts = [];
  parts.push(`${emoji} **${title}**`);
  if (description.length > 0) parts.push(description);
  if (evidence.length > 0) parts.push(`> \`${evidence}\``);
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
 * `event` defaults to `'COMMENT'` (advisory review). When strict mode lands
 * (Phase 8.3) a caller can pass `'REQUEST_CHANGES'` to block merge.
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
 * List prior reviews posted by the bot on a PR.
 *
 * Paginates `octokit.rest.pulls.listReviews` (per_page=100, loop until a short
 * page). Filters to reviews whose `body` includes `marker` OR whose `user.login`
 * ends with `[bot]`. This dual filter catches both the marker-bearing reviews
 * we posted AND any legacy bot-posted reviews that predate the marker.
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
  let page = 1;
  for (;;) {
    const { data } = await octokit.rest.pulls.listReviews({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: perPage,
      page,
    });
    const rows = Array.isArray(data) ? data : [];
    all.push(...rows);
    if (rows.length < perPage) break;
    page += 1;
  }

  return all.filter((r) => {
    const body = typeof r?.body === 'string' ? r.body : '';
    const login = typeof r?.user?.login === 'string' ? r.user.login : '';
    return body.includes(marker) || login.endsWith('[bot]');
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
 *   1. `listBotReviews` → prior reviews (marker OR bot login).
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
