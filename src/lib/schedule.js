/**
 * Scheduled batch review: re-review open, non-draft PRs whose head SHA has not
 * already been reviewed. This implements the v1 "schedule" stub.
 *
 * It is OPT-IN via `ZAI_SCHEDULE_ENABLED` (default false), so existing consumers
 * see no behavior change. When enabled, a `schedule` event:
 *   1. Lists open PRs (paginated, newest-updated first), capped at
 *      `ZAI_SCHEDULE_MAX_PRS` (default 10).
 *   2. Skips drafts.
 *   3. Skips PRs whose head SHA already has a Z.ai marker comment (dedup by
 *      SHA — only new/changed PRs get reviewed, so a stable PR is not
 *      re-reviewed on every cron tick).
 *   4. Runs the structured-review pipeline (`runStructuredReview`) and posts via
 *      the v2 inline-review path (`partitionFindings` → `buildReviewBody`/
 *      `buildReviewComments` → `upsertReview`) when findings map to diff lines,
 *      falling back to the summary comment when no finding is line-mappable —
 *      exactly the same code path as the `pull_request` event.
 *
 * Per-PR failures are logged and isolated; one bad PR never stops the batch.
 * All collaborators are INJECTED (DI-first) so tests never touch the network.
 *
 * @module src/lib/schedule.js
 */

import { MARKER, appendTrailers } from './comments.js';

/** Default cap on the number of PRs reviewed per scheduled run. */
export const DEFAULT_MAX_PRS = 10;

/**
 * Build the hidden HTML comment that embeds the PR head SHA in a posted
 * review/comment body. `hasReviewForSha` matches a bot-authored comment whose
 * body contains BOTH the marker AND the head SHA; without this block the
 * review body carries only the fixed marker literal, so the SHA match never
 * succeeds and a stable PR is re-reviewed on EVERY cron tick (defeating the
 * "only new/changed PRs" guarantee).
 *
 * The block is an HTML comment so it is invisible in the rendered comment.
 * Returns '' when `sha` is empty so callers can append unconditionally.
 *
 * @param {string} sha  the PR head SHA.
 * @returns {string}
 */
export function buildShaBlock(sha) {
  if (typeof sha !== 'string' || sha.length === 0) return '';
  return `<!-- zai-sha: ${sha} -->`;
}

/**
 * Determine whether a comment was authored by a bot. Used to gate marker-based
 * dedup so a drive-by human commenter cannot suppress a scheduled review or
 * hijack the bot's review thread by posting a comment containing the marker.
 *
 * Accepts EITHER signal GitHub surfaces for bot accounts: an explicit
 * `user.type === 'Bot'` (set for GitHub Apps bot accounts) OR a `user.login`
 * ending in `[bot]` (the convention for actions and other bot identities).
 *
 * @param {{user?: {type?: string, login?: string}}} comment
 * @returns {boolean}
 */
function isBotComment(comment) {
  const user = comment?.user;
  if (!user) return false;
  if (typeof user.type === 'string' && user.type === 'Bot') return true;
  return typeof user.login === 'string' && user.login.endsWith('[bot]');
}

/**
 * List open PRs (paginated), returning a minimal shape per PR. Stops once
 * `maxPrs` have been accumulated or the list is exhausted.
 *
 * @param {object} args `{ octokit, owner, repo, maxPrs, perPage }`
 * @returns {Promise<Array<{number: number, headSha: string, draft: boolean, title: string}>>}
 */
export async function listOpenPrs({
  octokit,
  owner,
  repo,
  maxPrs,
  perPage = 50,
}) {
  // CFG-3: drafts are NOT counted toward the maxPrs cap. Previously a batch of
  // stale drafts could fill the cap and starve real (non-draft) PRs of a
  // scheduled review. We skip drafts entirely during accumulation — they are
  // filtered again in runScheduledReview, but excluding them here means the
  // cap reflects only reviewable PRs.
  const out = [];
  let page = 1;
  for (;;) {
    // W2-1: capture the ACTUAL per_page sent to the API and compare data.length
    // against THAT value (not the original `perPage` parameter). The previous
    // code compared `data.length < perPage` (the parameter), which broke when
    // the dynamic per_page was clamped down by maxPrs: e.g. maxPrs=10, perPage=50
    // → requested 10; if page 1 returned 10 drafts (all skipped), 10 < 50 was
    // true so the loop terminated after page 1 even though page 2 had reviewable
    // PRs. Comparing against the requested size (10 < 10 → false) makes
    // pagination continue until the API truly returns a short page.
    const requestedPerPage = Math.min(perPage, Math.max(1, maxPrs - out.length) || perPage);
    const { data } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: requestedPerPage,
      page,
    });
    for (const pr of data) {
      if (pr?.draft === true) continue; // drafts don't count toward the cap
      out.push({
        number: pr.number,
        headSha: pr?.head?.sha ?? '',
        draft: false,
        title: typeof pr?.title === 'string' ? pr.title : '',
      });
      if (out.length >= maxPrs) return out;
    }
    if (data.length < requestedPerPage) break;
    page += 1;
  }
  return out;
}

/**
 * Determine whether a PR already has a Z.ai marker comment for the given head
 * SHA. Paginates `listComments` fully so a buried marker is still found.
 *
 * Returns true if a BOT-AUTHORED comment body contains both the marker and the
 * head SHA (the upsert updates the marker comment in place, so its body carries
 * the current SHA's review; matching on the SHA means a re-push to an old SHA
 * is detected as "not yet reviewed"). When the SHA is unknown, falls back to
 * marker-only matching.
 *
 * SECURITY: The author check (`user.type === 'Bot'` OR `user.login` ends with
 * `[bot]`) is mandatory. Without it, any commenter (including NONE-association
 * drive-by users) could post a comment containing the marker + head SHA and
 * cause the scheduled review to SKIP that PR — a trivial review-suppression.
 *
 * @param {object} args `{ octokit, owner, repo, pullNumber, headSha, marker }`
 * @returns {Promise<boolean>}
 */
export async function hasReviewForSha({
  octokit,
  owner,
  repo,
  pullNumber,
  headSha,
  marker = MARKER,
}) {
  // INT-3: an empty head SHA cannot confirm SHA-level dedup — previously the
  // `headSha === '' ||` short-circuit matched ANY bot marker comment and
  // suppressed the PR. Returning false here ensures the PR is reviewed.
  if (headSha === '') return false; // can't confirm SHA-level dedup; review it

  // Helper: does a single comment/review object count as our marker for this SHA?
  // W5-8: require the EXACT structured SHA block this action emits
  // (<!-- zai-sha: <sha> -->), not a bare substring mention of the SHA. The
  // marker and the SHA are public literals, so a different bot with comment
  // access could trivially post both as bare substrings and suppress the
  // review. Requiring the structured block raises the bar without breaking any
  // legitimate marker (which always carries it via buildShaBlock).
  const shaBlock = buildShaBlock(headSha);
  const matches = (c) =>
    isBotComment(c) &&
    typeof c?.body === 'string' &&
    c.body.includes(marker) &&
    c.body.includes(shaBlock);

  // W5-3: the marker + SHA block can live in EITHER an issue comment
  // (summary-comment path) OR a review (inline-review path via
  // pulls.createReview). Previously we searched only issue comments, so every
  // cron tick re-reviewed PRs whose findings mapped to diff lines — defeating
  // the SHA dedup. Search both, paginating each fully.
  const perPage = 100;

  // 1. Issue comments (issues.listComments).
  let page = 1;
  for (;;) {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: pullNumber,
      per_page: perPage,
      page,
    });
    if (comments.some(matches)) return true;
    if (comments.length < perPage) break;
    page += 1;
  }

  // 2. Reviews (pulls.listReviews) — where the inline-review path posts.
  // Guard for environments where the endpoint is absent (older mocks).
  if (typeof octokit?.rest?.pulls?.listReviews === 'function') {
    page = 1;
    for (;;) {
      const { data: reviews } = await octokit.rest.pulls.listReviews({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: perPage,
        page,
      });
      if (reviews.some(matches)) return true;
      if (reviews.length < perPage) break;
      page += 1;
    }
  }

  return false;
}

/**
 * Review a single PR using the structured-review pipeline. Mirrors the
 * `pull_request` branch of `run()` in src/index.js: fetch changed files, filter
 * excludes + patchable, short-circuit on zero patchable, run the structured
 * review, then post via the v2 inline-review pipeline (partition findings →
 * buildReviewBody/buildReviewComments → upsertReview) when at least one finding
 * maps to a diff line. Falls back to the legacy single summary comment when no
 * finding is line-mappable (all file-level or unmappable), and again to
 * postFallbackComment if the review submission itself fails — the review is
 * never silently lost.
 *
 * All collaborators are injected. Never throws — failures are returned as
 * `{ ok: false, error }` so the caller can log and continue the batch.
 *
 * @param {object} args
 * @returns {Promise<{ok: boolean, action?: string, error?: string}>}
 */
export async function reviewOnePr({
  pr,
  octokit,
  owner,
  repo,
  config,
  core,
  callApi,
  getChangedFiles,
  filterExcludedFiles,
  filterPatchableFiles,
  runStructuredReview,
  isLargePr,
  formatFindingsAsSummary,
  buildCommentBody,
  upsertReviewComment,
  // v2 inline-review pipeline deps.
  partitionFindings,
  buildReviewBody,
  buildReviewComments,
  upsertReview,
  postFallbackComment,
  resolveReviewEvent,
}) {
  try {
    let files = await getChangedFiles({ octokit, owner, repo, pullNumber: pr.number });
    files = filterExcludedFiles(files, config.excludePatterns);
    const patchable = filterPatchableFiles(files);
    if (patchable.length === 0) {
      return { ok: true, action: 'skipped-no-patchable' };
    }

    const result = await runStructuredReview(patchable, config, { callApi, core });

    // Synthetic @actions/github-like context. upsertReview reads
    // context.payload.pull_request.number; postFallbackComment delegates to the
    // shared postComment helper, which reads context.payload.issue.number — so
    // expose BOTH shapes (mirrors how src/index.js builds reviewContext).
    const ctx = {
      repo: { owner, repo },
      payload: {
        pull_request: { number: pr.number, head: { sha: pr.headSha } },
        issue: { number: pr.number },
      },
    };

    const { inline, summaryOnly } = partitionFindings(result.findings, patchable);

    if (inline.length > 0) {
      const baseBody = buildReviewBody(result.summary, summaryOnly, {
        reviewerName: config.reviewerName,
        walkthrough: config.walkthrough === true,
        files: patchable,
        deterministicFindingsCount: result.metadata.deterministicFindingsCount,
        truncated: Math.max(
          0,
          (result.metadata.totalFindingsBeforeCap || 0) - result.findings.length,
        ),
      });
      // Append the SHA block so hasReviewForSha can dedup-by-SHA on the next
      // cron tick (without it, the body carries only the marker and the PR is
      // re-reviewed every tick). Appended after the body so the marker scan and
      // rendered review are unaffected.
      const shaBlock = buildShaBlock(pr.headSha);
      const body = appendTrailers(baseBody, [shaBlock]);
      const comments = buildReviewComments(inline);
      const event = resolveReviewEvent(result.findings, config);
      try {
        await upsertReview({
          octokit,
          context: ctx,
          marker: MARKER,
          sha: pr.headSha,
          body,
          comments,
          event,
          core,
        });
      } catch (reviewError) {
        // NEVER silently lose the review. Fall back to a single issue comment
        // carrying the review body + every inline comment body as text.
        if (core?.warning) {
          core.warning(
            `Scheduled review submission failed for PR #${pr.number} (${reviewError?.message ?? String(reviewError)}); posting fallback comment.`,
          );
        }
        const fallbackBody = `${body}\n\n${comments.map((c) => c.body).join('\n\n')}`;
        await postFallbackComment({ octokit, context: ctx, body: fallbackBody });
      }
      return { ok: true, action: 'reviewed' };
    }

    // No inline-mappable findings: post the whole summary as an issue comment
    // via the existing marker-upsert path (legacy summary comment).
    const content = formatFindingsAsSummary(result.findings, {
      reviewerName: config.reviewerName,
      metadata: {
        deterministicFindingsCount: result.metadata.deterministicFindingsCount,
        truncated: Math.max(
          0,
          (result.metadata.totalFindingsBeforeCap || 0) - result.findings.length,
        ),
      },
    });

    const commentBody = buildCommentBody({
      title: config.reviewerName,
      content,
      marker: MARKER,
    });
    // Append the SHA block so hasReviewForSha can dedup-by-SHA on the next
    // cron tick (see the inline branch above for rationale).
    const shaBlock = buildShaBlock(pr.headSha);
    const body = appendTrailers(commentBody, [shaBlock]);
    await upsertReviewComment({
      octokit,
      owner,
      repo,
      issueNumber: pr.number,
      body,
      marker: MARKER,
      core,
    });
    return { ok: true, action: 'reviewed' };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/**
 * Run a scheduled review batch over open PRs.
 *
 * @param {object} args
 * @param {object} args.octokit
 * @param {string} args.owner
 * @param {string} args.repo
 * @param {object} args.config
 * @param {object} args.core  @actions/core-like logger.
 * @param {number} [args.maxPrs]  Cap on PRs reviewed this run.
 * @param {Function} args.callApi
 * @param {Function} [args.listOpenPrs]  Injected (default: listOpenPrs).
 * @param {Function} [args.hasReviewForSha]  Injected (default: hasReviewForSha).
 * @param {Function} args.getChangedFiles
 * @param {Function} args.filterExcludedFiles
 * @param {Function} args.filterPatchableFiles
 * @param {Function} args.runStructuredReview
 * @param {Function} args.isLargePr
 * @param {Function} args.formatFindingsAsSummary
 * @param {Function} args.buildCommentBody
 * @param {Function} args.upsertReviewComment
 * @param {Function} args.partitionFindings
 * @param {Function} args.buildReviewBody
 * @param {Function} args.buildReviewComments
 * @param {Function} args.upsertReview
 * @param {Function} args.postFallbackComment
 * @param {Function} args.resolveReviewEvent
 * @returns {Promise<{reviewed: number, skipped: number, failed: number}>}
 */
export async function runScheduledReview({
  octokit,
  owner,
  repo,
  config,
  core,
  // maxPrs: optional HARD ceiling (test injection). Default Infinity so the
  // operator's ZAI_SCHEDULE_MAX_PRS (via config.scheduleMaxPrs) is the primary
  // source. See cap-resolution comment below.
  maxPrs = Number.POSITIVE_INFINITY,
  callApi,
  listOpenPrs: listFn = listOpenPrs,
  hasReviewForSha: hasReviewFn = hasReviewForSha,
  getChangedFiles,
  filterExcludedFiles,
  filterPatchableFiles,
  runStructuredReview,
  isLargePr,
  formatFindingsAsSummary,
  buildCommentBody,
  upsertReviewComment,
  partitionFindings,
  buildReviewBody,
  buildReviewComments,
  upsertReview,
  postFallbackComment,
  resolveReviewEvent,
}) {
  // Effective cap resolution. `config.scheduleMaxPrs` (from
  // ZAI_SCHEDULE_MAX_PRS) is the PRIMARY source — the operator-set knob. The
  // `maxPrs` PARAMETER is an optional HARD ceiling for test injection only
  // (default Infinity = no ceiling). When config is unset, fall back to
  // DEFAULT_MAX_PRS. This fixes a bug where the param default (10) silently
  // clamped an operator's ZAI_SCHEDULE_MAX_PRS=50 to 10.
  const configMaxPrs =
    typeof config?.scheduleMaxPrs === 'number' && config.scheduleMaxPrs > 0
      ? config.scheduleMaxPrs
      : DEFAULT_MAX_PRS;
  const ceiling =
    typeof maxPrs === 'number' && maxPrs > 0 ? maxPrs : Number.POSITIVE_INFINITY;
  const cap = Math.min(configMaxPrs, ceiling);

  const prs = await listFn({ octokit, owner, repo, maxPrs: cap });
  let reviewed = 0;
  let skipped = 0;
  let failed = 0;

  for (const pr of prs) {
    if (pr.draft) {
      skipped += 1;
      continue;
    }
    // Dedup: skip PRs already reviewed at this head SHA.
    const already = await hasReviewFn({
      octokit,
      owner,
      repo,
      pullNumber: pr.number,
      headSha: pr.headSha,
    });
    if (already) {
      skipped += 1;
      continue;
    }

    const result = await reviewOnePr({
      pr,
      octokit,
      owner,
      repo,
      config,
      core,
      callApi,
      getChangedFiles,
      filterExcludedFiles,
      filterPatchableFiles,
      runStructuredReview,
      isLargePr,
      formatFindingsAsSummary,
      buildCommentBody,
      upsertReviewComment,
      partitionFindings,
      buildReviewBody,
      buildReviewComments,
      upsertReview,
      postFallbackComment,
      resolveReviewEvent,
    });

    if (result.ok) {
      reviewed += 1;
      if (core?.info) core.info(`Scheduled review: PR #${pr.number} ${result.action}.`);
    } else {
      failed += 1;
      if (core?.warning) {
        core.warning(`Scheduled review: PR #${pr.number} failed (${result.error}).`);
      }
    }
  }

  if (core?.info) {
    core.info(
      `Scheduled review complete: ${reviewed} reviewed, ${skipped} skipped, ${failed} failed.`,
    );
  }
  return { reviewed, skipped, failed };
}
