/**
 * Idempotent summary-comment upsert for PR reviews.
 *
 * Posts a SINGLE summary comment per PR, updated in place via a hidden HTML
 * comment marker so re-runs (e.g. on `synchronize`) don't pile up duplicates.
 *
 * Octokit and `@actions/core`-like `core` are INJECTED — never imported at
 * module load — so this module stays pure and unit-testable.
 */

import { sanitizeCommentBody } from './sanitize-output.js';

/** Hidden HTML comment marker used to find the existing review comment. */
export const MARKER = '<!-- zai-code-review -->';

/**
 * Determine whether a comment or review was authored by a bot. The SINGLE
 * bot-authority predicate (F-BOTGATE): previously duplicated as
 * `isBotComment` (comments.js), `isBotReview` (review.js), and
 * `isBotComment` (schedule.js) — three lockstep copies of the same
 * audit-hardened gate. Used to gate marker-based matching so a drive-by human
 * commenter cannot post the marker and cause the bot to overwrite THEIR
 * comment (comment hijack) or get their review dismissed (W15-A3-6
 * quote-reply guard). Accepts EITHER signal GitHub surfaces for bot accounts:
 * `user.type === 'Bot'` (GitHub Apps bot accounts) OR `user.login` ending in
 * `[bot]` (actions and other bots). A missing/absent `user` object cannot
 * prove authorship and is treated as non-bot.
 *
 * @param {{user?: {type?: string, login?: string}}} item
 * @returns {boolean}
 */
export function isBotAuthor(item) {
  const user = item?.user;
  if (!user) return false;
  if (typeof user.type === 'string' && user.type === 'Bot') return true;
  return typeof user.login === 'string' && user.login.endsWith('[bot]');
}

/**
 * Shared pagination loop (CORE-4) for the bot-marker enumeration (F-BOTGATE):
 * the single owner of the per_page-100/cap-100-pages loop that previously
 * existed as parallel copies in `findBotMarkerComments` (comments.js) and
 * `listBotReviews` (review.js).
 *
 * Calls `fetchPage(page)` with 1-based page numbers until a short page
 * (fewer than `perPage` items), an empty page, or a non-array page is seen,
 * or until `maxPages` pages have been fetched — whichever comes first. A
 * misbehaving endpoint that never returns a short page therefore cannot trap
 * callers in an unbounded loop.
 *
 * A non-array page is treated as end-of-data (items collected so far are
 * returned), but is no longer SILENT: when an optional @actions/core-like
 * `core` is supplied (Task-4 observability), ONE warning is emitted so a
 * misbehaving/mis-shaped endpoint is greppable in the action log. No
 * behavior change when `core` is absent (the warning channel is inert).
 *
 * `fetchPage` rejections propagate (not swallowed) — callers wrap them in
 * their own fail-soft boundary.
 *
 * @param {(page: number) => Promise<Array>} fetchPage  Resolves the batch for a page.
 * @param {object} [options]
 * @param {number} [options.perPage=100]  Page size; a shorter batch ends the loop.
 * @param {number} [options.maxPages=100] Hard cap on pages fetched (CORE-4).
 * @param {object} [options.core]  Optional @actions/core-like logger ({warning}).
 * @returns {Promise<Array>} every item across all fetched pages, in API order.
 */
export async function collectPages(fetchPage, { perPage = 100, maxPages = 100, core } = {}) {
  const items = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await fetchPage(page);
    if (!Array.isArray(batch)) {
      // Task-4: keep the stop-on-non-array semantics but surface it — the
      // old behavior (pre-F-BOTGATE throw) at least failed loudly; the
      // collected-items return was silent. One warning, exact greppable text.
      core?.warning?.('pagination: non-array page received; stopping enumeration');
      break;
    }
    if (batch.length === 0) break;
    items.push(...batch);
    if (batch.length < perPage) break;
  }
  return items;
}

/**
 * Like {@link collectPages}, but stops at the first item where `matches`
 * returns true and returns true; false if enumeration completes with no match.
 * Same page/short-page/cap semantics as collectPages — an existence check
 * (e.g. schedule.js's SHA-dedup read) never materializes the full history
 * when the match is on an early page.
 *
 * Task-4 symmetry: the same optional `core` warning channel as collectPages —
 * a non-array page stops enumeration (false) and emits ONE warning when a
 * core-like logger is supplied; silent otherwise.
 *
 * `fetchPage` rejections propagate (not swallowed) — callers wrap them in
 * their own fail-soft boundary.
 *
 * @param {(page: number) => Promise<Array>} fetchPage  Resolves the batch for a page.
 * @param {(item: *) => boolean} matches  Item predicate; first true wins.
 * @param {object} [options]
 * @param {number} [options.perPage=100]  Page size; a shorter batch ends the loop.
 * @param {number} [options.maxPages=100] Hard cap on pages fetched (CORE-4).
 * @param {object} [options.core]  Optional @actions/core-like logger ({warning}).
 * @returns {Promise<boolean>} true on the first matching item, else false.
 */
export async function collectPagesSome(
  fetchPage,
  matches,
  { perPage = 100, maxPages = 100, core } = {},
) {
  for (let page = 1; page <= maxPages; page++) {
    const batch = await fetchPage(page);
    if (!Array.isArray(batch)) {
      core?.warning?.('pagination: non-array page received; stopping enumeration');
      return false;
    }
    if (batch.length === 0) return false;
    for (const item of batch) if (matches(item)) return true;
    if (batch.length < perPage) return false;
  }
  return false;
}

/**
 * Build the comment body from a title and content, appending the marker. The
 * model `content` is run through the output sanitizer first so an indirect
 * prompt-injection cannot coax the bot into emitting @mention spam or forged
 * GitHub alert banners under its trusted identity. The title and marker are
 * preserved verbatim (the marker must remain byte-exact for idempotent upsert).
 *
 * The CALLER normally uses this to assemble the body before passing it to
 * `upsertReviewComment`; `upsertReviewComment` itself never mutates the body.
 *
 * @param {{title?: string, content: string, marker: string}} args
 * @returns {string}
 */
export function buildCommentBody({ title, content, marker }) {
  // Sanitize the model output only; the title/marker are operator-controlled.
  const safeContent = sanitizeCommentBody(String(content ?? ''));
  // W5-9: some callers (formatFindingsAsSummary, formatWalkthroughSummary)
  // emit content that ALREADY starts with `## <reviewerName>` and ends with
  // the marker. Re-wrapping would produce a duplicate H2 heading and a
  // duplicate trailing marker on the rendered PR comment. When the sanitized
  // content already carries both, return it verbatim instead of re-wrapping.
  // W11-8: tolerate trailing horizontal whitespace after the heading text
  // (`## Title \n`), which used to fail the exact-string check and produced a
  // duplicate H2 heading. Compare on the first line with trailing whitespace
  // stripped.
  const trimmed = safeContent.trimEnd();
  // W13-1: when content has no newline, indexOf('\n') returns -1 and
  // Math.max(0,-1)=0, making firstLine='' — which always fails the heading
  // check and produces a duplicate H2. Handle the no-newline case: the whole
  // trimmed string IS the first line.
  const nlIdx = trimmed.indexOf('\n');
  const firstLine = nlIdx === -1 ? trimmed : trimmed.slice(0, nlIdx);
  const hasHeading = !!title && firstLine.replace(/[ \t]+$/, '') === `## ${title}`;
  const hasMarker = trimmed.endsWith(marker);
  if (hasHeading && hasMarker) {
    return trimmed;
  }
  // W12-3b: content already has the heading but NOT the marker — append the
  // marker without re-wrapping (re-wrapping would duplicate the heading).
  if (hasHeading) {
    return `${trimmed}\n\n${marker}`;
  }
  if (title) {
    return `## ${title}\n\n${safeContent}\n\n${marker}`;
  }
  return `${safeContent}\n\n${marker}`;
}

/**
 * Append hidden HTML-comment "trailer" blocks to a body.
 *
 * Used to attach the incremental-review hash block and the schedule-dedup SHA
 * block after a review/comment body. Empty/falsy blocks are dropped; the rest
 * are joined with newlines and appended after a separating newline. Returns
 * the body unchanged when no non-empty trailers are supplied.
 *
 * Centralized so the separator and empty-filtering logic stays consistent
 * across every body-construction site (inline review, summary comment,
 * scheduled review).
 *
 * @param {string} body  The base body (already includes the marker).
 * @param {Array<string|null|undefined>} trailers  Hidden-comment blocks to append.
 * @returns {string}
 */
export function appendTrailers(body, trailers = []) {
  const list = Array.isArray(trailers)
    ? trailers.filter((s) => typeof s === 'string' && s.length > 0)
    : [];
  if (list.length === 0) return body;
  return `${body}\n${list.join('\n')}`;
}

/**
 * Find ALL bot-authored marker comments on an issue/PR, in API order.
 *
 * W16-B2-3: {@link findBotMarkerComment} returns only the FIRST bot marker
 * comment in API order. When a fallback comment exists (created after an
 * inline-review failure — the fallback path always CREATES a new comment),
 * its hash block (the newest full set) was never read — orphaned suppression
 * data. Consumers that aggregate per-comment payloads (e.g. the
 * incremental-review hash union in src/index.js) need the FULL list.
 *
 * Pagination is owned by {@link collectPages} (F-BOTGATE): per_page=100, loop
 * until a short page or the 100-page cap is reached (CORE-4 loop guard).
 * Bot authorship is REQUIRED via {@link isBotAuthor} (comment hijack
 * defense): only `user.type === 'Bot'` OR `user.login` ending in `[bot]` is
 * eligible — a human comment quoting the marker (and a forged hash block)
 * can never feed suppression.
 *
 * `listComments` rejections propagate (not swallowed) — callers wrap in their
 * own fail-soft boundary.
 *
 * @param {object} args
 * @param {object} args.octokit      Octokit instance (rest.issues.listComments used).
 * @param {string} args.owner        Repository owner.
 * @param {string} args.repo         Repository name.
 * @param {number} args.issueNumber  PR / issue number.
 * @param {string} [args.marker]     Marker used to locate the comments (default {@link MARKER}).
 * @param {number} [args.perPage=100] Page size for listComments pagination.
 * @param {object} [args.core]       Optional @actions/core-like logger ({warning}) forwarded
 *                                   to {@link collectPages} (Task-4 non-array-page observability).
 * @returns {Promise<Array<{id:number, body?:string}>>} every bot marker comment (API order); [] when none.
 */
export async function findBotMarkerComments({
  octokit,
  owner,
  repo,
  issueNumber,
  marker = MARKER,
  perPage = 100,
  core,
}) {
  // Paginate fully via the shared loop: marker comments can be anywhere in
  // the history (the original summary comment AND a later fallback comment
  // may live pages apart), and a single page would miss all but the first
  // 100. collectPages caps at 100 pages so a misbehaving endpoint cannot
  // trap us in an unbounded loop.
  const comments = await collectPages(
    (page) =>
      octokit
        .rest.issues.listComments({
          owner,
          repo,
          issue_number: issueNumber,
          per_page: perPage,
          page,
        })
        .then((r) => r.data),
    { perPage, core },
  );

  return comments.filter(
    (c) => isBotAuthor(c) && typeof c?.body === 'string' && c.body.includes(marker),
  );
}

/**
 * Find the FIRST bot-authored marker comment on an issue/PR.
 *
 * Extracted from the lookup loop inside {@link upsertReviewComment} (W15-A8-3)
 * so other call sites can reuse the exact same pagination + bot-authority
 * gating — notably the incremental-review hash-block read in src/index.js,
 * which must never trust a human comment carrying a forged marker/hash block.
 *
 * W16-B2-3: now a thin first-match wrapper over {@link findBotMarkerComments}
 * (the plural finder owns the pagination + bot-authority loop) so existing
 * callers keep their semantics: the first bot marker comment in API order, or
 * null when none exists.
 *
 * `listComments` rejections propagate (not swallowed) — callers wrap in their
 * own fail-soft boundary.
 *
 * @param {object} args  Same shape as {@link findBotMarkerComments}.
 * @returns {Promise<{id:number, body?:string}|null>} the found comment, or null.
 */
export async function findBotMarkerComment(args) {
  const all = await findBotMarkerComments(args);
  return all.length > 0 ? all[0] : null;
}

/**
 * Upsert the single summary review comment on a PR.
 *
 * 1. List issue comments, PAGINATING fully (page=1, per_page=100, loop until a
 *    short page) so the marker lookup inspects EVERY comment — not just the
 *    first 100. Without full pagination a PR with >100 comments would lose the
 *    marker comment from the visible window and create a duplicate summary on
 *    every run. (Delegated to {@link findBotMarkerComment}.)
 * 2. Find the first BOT-AUTHORED comment whose body contains `marker` (default
 *    {@link MARKER}). The author check (`user.type === 'Bot'` OR `user.login`
 *    ends with `[bot]`) is mandatory: without it, a non-bot user could post a
 *    comment containing the marker and the bot would overwrite THEIR comment on
 *    every run — a comment-hijack that lets an attacker masquerade as the bot.
 * 3. Update it if found, otherwise create a new comment.
 *
 * `listComments` rejections propagate (not swallowed).
 *
 * @param {object} args
 * @param {object} args.octokit  Octokit instance (rest.issues.* used).
 * @param {string} args.owner    Repository owner.
 * @param {string} args.repo     Repository name.
 * @param {number} args.issueNumber  PR / issue number.
 * @param {string} args.body     Comment body (already includes marker if desired).
 * @param {string} [args.marker] Marker used to locate the existing comment.
 * @param {number} [args.perPage=100] Page size for listComments pagination.
 * @param {{info?: Function, warning?: Function}} [args.core]  Optional @actions/core-like
 *                                   logger ({info} for upsert logging; {warning} forwarded to
 *                                   {@link collectPages} via the marker lookup — Task-4).
 * @returns {Promise<{action: 'updated'|'created', commentId: number}>}
 */
export async function upsertReviewComment({
  octokit,
  owner,
  repo,
  issueNumber,
  body,
  marker = MARKER,
  perPage = 100,
  core,
}) {
  const existing = await findBotMarkerComment({
    octokit,
    owner,
    repo,
    issueNumber,
    marker,
    perPage,
    core,
  });

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
    if (core?.info) core.info(`Updated existing review comment ${existing.id}`);
    return { action: 'updated', commentId: existing.id };
  }

  const { data: created } = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
  if (core?.info) core.info(`Created review comment ${created.id}`);
  return { action: 'created', commentId: created.id };
}
