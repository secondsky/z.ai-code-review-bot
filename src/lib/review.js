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
 * BOT-AUTHORED reviews whose body includes the marker (W15-A3-6: a human
 * "Quote reply" copies the marker and must never be matched), CREATES the
 * fresh review, then DISMISSES the prior ones — excluding the new review — so
 * stale inline comments disappear on re-push. This "create-then-dismiss-stale"
 * sequence (W15-A7-5) keeps exactly one active bot review per PR head SHA
 * without piling up duplicates, and guarantees a transient createReview
 * failure can never leave the PR with the prior review already dismissed and
 * no replacement posted.
 *
 * @module src/lib/review.js
 */

import { MARKER } from './comments.js';
import { sanitizeModelOutput, sanitizeCommentBody } from './sanitize-output.js';
import { sanitizeTextField } from './findings.js';
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
    // W17-C1-1: the summary is model-controlled prose rendered into the bot's
    // trusted review body — the PRIMARY inline-review path (index.js /
    // schedule.js), also recycled by buildFallbackBody. W16's B1-4 sanitization
    // covered formatFindingsAsSummary and formatWalkthroughSummary but MISSED
    // this renderer, so 'ok\n#### X\n<img src=x>' injected a real heading and
    // raw HTML here. Apply the same sanitizeTextField treatment (newline
    // collapse + angle-bracket escaping) as the other two summary renderers.
    lines.push(sanitizeTextField(summary));
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
        // W8-1: replace backticks with "'" (backslash escapes do NOT work
        // inside CommonMark code spans, so the W7-4 \` escape was illusory).
        const safeFile = file.replace(/`/g, "'");
        lines.push(`- \`${safeFile}\` — ${title}`);
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
  // W17-C1-2: CommonMark treats a LONE \r as a line ending too, so normalize
  // \r\n? → \n first — otherwise 'a\rb' kept its raw \r and GitHub's renderer
  // split the line there, letting the text after it start a heading/quote of
  // its own.
  const stripNewlines = (s) =>
    String(s)
      .replace(/\r\n?/g, '\n')
      .replace(/\n/g, ' ');
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
    // W17-C1-2: lone \r is a CommonMark line ending too — normalize \r\n? → \n
    // before collapsing so a CR cannot split the code span either.
    const safeEvidence = evidence
      .replace(/`/g, "'")
      .replace(/\r\n?/g, '\n')
      .replace(/\n/g, ' ');
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
 * Determine whether a review was authored by a bot. Gates marker-based
 * matching in {@link listBotReviews} so a HUMAN review carrying the marker —
 * e.g. created via GitHub's "Quote reply", which copies the invisible
 * {@link MARKER} — is never treated as the bot's own review and never
 * dismissed (W15-A3-6: dismissing a human REQUEST_CHANGES review would
 * silently unblock the PR merge). Mirrors `isBotComment` in comments.js:
 * accepts EITHER signal GitHub surfaces for bot accounts, `user.type ===
 * 'Bot'` (GitHub Apps bot accounts) OR `user.login` ending in `[bot]`
 * (actions and other bots). Reviews with a missing/absent `user` object
 * cannot prove authorship and are treated as non-bot.
 *
 * @param {{user?: {type?: string, login?: string}}} review
 * @returns {boolean}
 */
function isBotReview(review) {
  const user = review?.user;
  if (!user) return false;
  if (typeof user.type === 'string' && user.type === 'Bot') return true;
  return typeof user.login === 'string' && user.login.endsWith('[bot]');
}

/**
 * List prior reviews posted by the bot on a PR.
 *
 * Paginates `octokit.rest.pulls.listReviews` (per_page=100, loop until a short
 * page). Filters to reviews that BOTH carry `marker` in `body` AND are
 * bot-authored ({@link isBotReview}). The marker is the canonical idempotency
 * signal — every review this action posts carries it — so the broad
 * `[bot]`-login fallback that previously matched ANY bot (e.g. dependabot,
 * github-actions) was removed to avoid dismissing reviews this action never
 * posted (CORE-3). Bot authorship is additionally REQUIRED (W15-A3-6): a
 * human "Quote reply" copies the invisible marker, and marker-only matching
 * made the next run dismiss the human's review — silently unblocking a human
 * REQUEST_CHANGES review. This mirrors the authorship gate `comments.js`
 * applies to marker comments.
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
    // W15-A3-6: the marker must ALSO be paired with bot authorship — a human
    // "Quote reply" copies the marker, and that must never be dismissed.
    return body.includes(marker) && isBotReview(r);
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
 * Post a review with inline comments. Idempotent per SHA: creates the new
 * review first, then dismisses prior bot reviews.
 *
 * Flow:
 *   1. `listBotReviews` → prior reviews (matched by marker in body AND bot
 *      authorship).
 *   2. `pulls.createReview({owner, repo, pull_number, body, event, comments})`.
 *   3. `dismissStaleReviews` with `message: "Superseded by re-review at <sha>"`,
 *      EXCLUDING the review created in step 2.
 *
 * W15-A7-5: the new review is created BEFORE the stale ones are dismissed. The
 * previous dismiss-first order meant a transient `createReview` failure (502,
 * secondary rate limit) left the prior run's inline review already dismissed
 * with nothing replacing it — the findings were silently lost. Create-first
 * guarantees a dismissal only ever happens once the replacement exists; if
 * `createReview` throws, no dismissals occur and the error propagates to the
 * caller (which falls back to an issue comment).
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

  const payload = buildReviewPayload({ body, comments, event });
  const { data } = await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: pullNumber,
    body: payload.body,
    event: payload.event,
    comments: payload.comments,
  });

  // The fresh review must never be dismissed as stale. `prior` was listed
  // BEFORE creation so the new id cannot be in it, but filter defensively —
  // the contract is "exactly the stale bot reviews are dismissed".
  const newId = data?.id;
  const stale = prior.filter((r) => r?.id !== newId);
  await dismissStaleReviews({ octokit, context, reviews: stale, reason, core });

  return {
    id: newId,
    commentCount: payload.comments.length,
    dismissedCount: stale.length,
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
export async function postFallbackComment({ octokit, context, body, trailers = [] }) {
  return postComment({ octokit, context, body, trailers });
}
