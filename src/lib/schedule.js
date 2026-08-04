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
 *   4. Runs the structured-review pipeline (`runStructuredReview`) and upserts
 *      the summary comment — exactly the same code path as the `pull_request`
 *      event.
 *
 * Per-PR failures are logged and isolated; one bad PR never stops the batch.
 * All collaborators are INJECTED (DI-first) so tests never touch the network.
 *
 * @module src/lib/schedule.js
 */

import { MARKER } from './comments.js';

/** Default cap on the number of PRs reviewed per scheduled run. */
export const DEFAULT_MAX_PRS = 10;

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
  const out = [];
  let page = 1;
  for (;;) {
    const { data } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: Math.min(perPage, Math.max(1, maxPrs - out.length) || perPage),
      page,
    });
    for (const pr of data) {
      out.push({
        number: pr.number,
        headSha: pr?.head?.sha ?? '',
        draft: pr?.draft === true,
        title: typeof pr?.title === 'string' ? pr.title : '',
      });
      if (out.length >= maxPrs) return out;
    }
    if (data.length < perPage) break;
    page += 1;
  }
  return out;
}

/**
 * Determine whether a PR already has a Z.ai marker comment for the given head
 * SHA. Paginates `listComments` fully so a buried marker is still found.
 *
 * Returns true if ANY comment body contains both the marker and the head SHA
 * (the upsert updates the marker comment in place, so its body carries the
 * current SHA's review; matching on the SHA means a re-push to an old SHA is
 * detected as "not yet reviewed"). When the SHA is unknown, falls back to
 * marker-only matching.
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
  let page = 1;
  const perPage = 100;
  for (;;) {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: pullNumber,
      per_page: perPage,
      page,
    });
    const found = comments.some(
      (c) =>
        typeof c?.body === 'string' &&
        c.body.includes(marker) &&
        (headSha === '' || c.body.includes(headSha)),
    );
    if (found) return true;
    if (comments.length < perPage) return false;
    page += 1;
  }
}

/**
 * Review a single PR using the structured-review pipeline. Mirrors the
 * `pull_request` branch of `run()` in src/index.js: fetch changed files, filter
 * excludes + patchable, short-circuit on zero patchable, run the structured
 * review, render via formatFindingsAsSummary, and upsert the summary comment.
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
}) {
  try {
    let files = await getChangedFiles({ octokit, owner, repo, pullNumber: pr.number });
    files = filterExcludedFiles(files, config.excludePatterns);
    const patchable = filterPatchableFiles(files);
    if (patchable.length === 0) {
      return { ok: true, action: 'skipped-no-patchable' };
    }

    const result = await runStructuredReview(patchable, config, { callApi, core });

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

    const body = buildCommentBody({
      title: config.reviewerName,
      content,
      marker: MARKER,
    });
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
 * @returns {Promise<{reviewed: number, skipped: number, failed: number}>}
 */
export async function runScheduledReview({
  octokit,
  owner,
  repo,
  config,
  core,
  maxPrs = DEFAULT_MAX_PRS,
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
}) {
  const cap =
    typeof config?.scheduleMaxPrs === 'number' && config.scheduleMaxPrs > 0
      ? Math.min(config.scheduleMaxPrs, maxPrs)
      : maxPrs;

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
