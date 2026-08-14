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
import { formatWalkthroughSummary as formatWalkthroughSummaryDefault } from './walkthrough.js';
import { buildStatusDescription as buildStatusDescriptionDefault } from './status.js';

/** Default cap on the number of PRs reviewed per scheduled run. */
export const DEFAULT_MAX_PRS = 10;

/* ------------------------------------------------------------------ *
 * W15-A8-4 feature-parity default deps.
 *
 * The new collaborators (repo config, scanners, learnings, commit statuses)
 * are OPTIONAL and default to INERT no-ops so schedule.js stays hermetic when
 * called without the full dep kit (existing tests, embedding). src/index.js's
 * schedule branch wires the REAL functions for production runs. Pure helpers
 * (renderers, description builders) default to their real implementations —
 * they never touch the network.
 * ------------------------------------------------------------------ */

/** Inert `.zai.yml` loader: never fetches; behaves like a repo without one. */
const defaultLoadRepoConfig = async () => ({});

/** Inert merge: pass the action config through unchanged (no repo narrowing). */
const defaultMergeRepoConfig = (actionConfig = {}) => ({ ...actionConfig });

/** Inert scanner orchestrator: no findings, no metrics, no scanners run. */
const defaultRunScanners = async () => ({ findings: [], metrics: {}, scannerNames: [] });

/** Inert scanner-context formatter: contributes nothing to the prompt. */
const defaultFormatScannerContext = () => '';

/** Inert learnings loader: behaves like a repo without `.zai/learnings.yml`. */
const defaultLoadLearnings = async () => [];

/** Inert learnings prompt formatter: no prompt context. */
const defaultFormatLearningsForPrompt = () => '';

/** Inert learnings suppression: keep everything, suppress nothing. */
const defaultFilterFindingsByLearnings = (findings) => ({
  kept: Array.isArray(findings) ? findings : [],
  suppressed: 0,
});

/** Inert status poster: never touches the API (status feedback is opt-in). */
const defaultSetReviewStatus = async () => false;

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
  // W11-12: CORE-4 added MAX_PAGES caps to changed-files.js, comments.js, and
  // review.js to prevent a pathological endpoint from trapping pagination in an
  // unbounded loop. schedule.js was missed. A repo with many open DRAFT PRs
  // (all skipped) and the cap unfilled would paginate without a ceiling. The
  // same cap is applied to hasReviewForSha below.
  const MAX_LIST_PAGES = 100;
  const out = [];
  let page = 1;
  for (; page <= MAX_LIST_PAGES; page++) {
    // W2-1: capture the ACTUAL per_page sent to the API and compare data.length
    // against THAT value (not the original `perPage` parameter). The previous
    // code compared `data.length < perPage` (the parameter), which broke when
    // the dynamic per_page was clamped down by maxPrs: e.g. maxPrs=10, perPage=50
    // → requested 10; if page 1 returned 10 drafts (all skipped), 10 < 50 was
    // true so the loop terminated after page 1 even though page 2 had reviewable
    // PRs. Comparing against the requested size (10 < 10 → false) makes
    // pagination continue until the API truly returns a short page.
    //
    // W15-A6-1: the per_page must also be CONSTANT across pages. GitHub
    // paginates by offset ((page-1)*per_page); recomputing a SMALLER per_page
    // for page 2 (the old `min(perPage, maxPrs - out.length)` clamp) moved the
    // offset window BACKWARD over items already seen when drafts were skipped
    // on page 1 — returning DUPLICATE PRs (verified: [2,3,4,5,6,8,9,10,3,4])
    // and starving tail PRs of review. The clamp is dropped entirely: the
    // ingest loop below already stops at maxPrs, so the cap is still honored.
    const requestedPerPage = perPage;
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
  // W11-12: cap pagination so a PR with a very large comment/review history
  // cannot stall a scheduled run (consistent with CORE-4 caps elsewhere).
  const MAX_COMMENT_PAGES = 100;

  // 1. Issue comments (issues.listComments).
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: pullNumber,
      per_page: perPage,
      page,
    });
    if (comments.some(matches)) return true;
    if (comments.length < perPage) break;
  }

  // 2. Reviews (pulls.listReviews) — where the inline-review path posts.
  // Guard for environments where the endpoint is absent (older mocks).
  if (typeof octokit?.rest?.pulls?.listReviews === 'function') {
    for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
      const { data: reviews } = await octokit.rest.pulls.listReviews({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: perPage,
        page,
      });
      if (reviews.some(matches)) return true;
      if (reviews.length < perPage) break;
    }
  }

  return false;
}

/**
 * Review a single PR using the structured-review pipeline. Partially mirrors
 * the `pull_request` branch of `run()` in src/index.js: fetch changed files,
 * filter excludes + patchable, short-circuit on zero patchable, run the
 * structured review, then post via the v2 inline-review pipeline (partition
 * findings → buildReviewBody/buildReviewComments → upsertReview) when at least
 * one finding maps to a diff line. Falls back to the legacy single summary
 * comment when no finding is line-mappable (all file-level or unmappable), and
 * again to postFallbackComment if the review submission itself fails — the
 * review is never silently lost.
 *
 * KNOWN LIMITATION → RESOLVED (W8-3 / W15-A8-4): the scheduled path now loads
 * and merges `.zai.yml` repo config (path_filters, path/tone instructions,
 * chill profile narrowing), runs the deterministic scanners (gitleaks /
 * ast-grep / metrics, with the repo's disable-only toggles), loads
 * `.zai/learnings.yml` (prompt context + post-review suppression), posts
 * pending/success commit statuses, and renders walkthrough summaries — the
 * same feature set as the `pull_request` path. Every collaborator is
 * deps-injectable with inert defaults so tests stay hermetic; src/index.js's
 * schedule branch wires the real functions.
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
  // W15-A6-4: walkthrough parity — index.js renders the summary-only branch
  // via formatWalkthroughSummary when config.walkthrough is on; the scheduled
  // path must mirror that so cron and push runs render the same PR the same
  // way. Optional dep (default: the real renderer from walkthrough.js).
  formatWalkthroughSummary = formatWalkthroughSummaryDefault,
  // W15-A8-4 feature-parity deps (all OPTIONAL with inert defaults so existing
  // tests/hermetic callers stay green; src/index.js's schedule branch wires the
  // real functions — see run()'s schedule wiring).
  // (a) .zai.yml repo config: load (fail-soft, returns {} on any error by
  //     contract) + merge (action inputs always win; repo can only narrow).
  loadRepoConfig = defaultLoadRepoConfig,
  mergeRepoConfig = defaultMergeRepoConfig,
  // (b) deterministic scanners: run over the patchable files; findings flow
  //     into runStructuredReview as `deterministicFindings` and their formatted
  //     context rides the LLM prompt as `scannerContext`.
  runScanners = defaultRunScanners,
  formatScannerContext = defaultFormatScannerContext,
  // (c) learnings: load `.zai/learnings.yml` (fail-soft → []), format the
  //     accepted patterns as prompt context, and suppress matching findings
  //     after the review (same three seams as index.js).
  loadLearnings = defaultLoadLearnings,
  formatLearningsForPrompt = defaultFormatLearningsForPrompt,
  filterFindingsByLearnings = defaultFilterFindingsByLearnings,
  // (d) commit statuses: `pending` at the start of the review work and
  //     `success` computed from the FINAL kept findings (post-suppression).
  //     setReviewStatus is fail-soft by contract; buildStatusDescription is a
  //     pure helper (defaults to the real one from status.js).
  setReviewStatus = defaultSetReviewStatus,
  buildStatusDescription = buildStatusDescriptionDefault,
}) {
  try {
    let files = await getChangedFiles({ octokit, owner, repo, pullNumber: pr.number });
    files = filterExcludedFiles(files, config.excludePatterns);
    let patchable = filterPatchableFiles(files);
    if (patchable.length === 0) {
      return { ok: true, action: 'skipped-no-patchable' };
    }

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

    // W15-A8-4d: `pending` commit status parity — the push path posts it right
    // after the zero-patchable short-circuit (so an empty PR never gets a
    // dangling status) and before the heavier review work, so developers see
    // immediate feedback on a cron tick too. Fail-soft; gated by config so an
    // operator without `statuses: write` can turn it off.
    if (config.commitStatus) {
      await setReviewStatus(
        {
          octokit,
          context: ctx,
          sha: pr.headSha,
          state: 'pending',
          description: 'Z.ai review in progress…',
        },
        { core },
      );
    }

    // W15-A8-4a: `.zai.yml` parity. The push path (src/index.js) loads the
    // in-repo config at the head SHA, merges it under the action config, and
    // RE-FILTERS the patchable set with the merged path_filters (W6-1: the
    // initial filter ran before the merge, so repo-defined excludes were
    // silently ignored). The scheduled path previously skipped all of this
    // (the old "KNOWN LIMITATION (W8-3)" gap). loadRepoConfig is fail-soft by
    // contract (any failure → {} + warning); a throwing injectable is guarded
    // here too so one broken config fetch can never fail the whole PR review.
    let rawRepoConfig = {};
    if (config.repoConfigEnabled) {
      try {
        rawRepoConfig = await loadRepoConfig(
          { octokit, context: ctx, headSha: pr.headSha },
          { core },
        );
      } catch (repoConfigError) {
        if (core?.warning) {
          core.warning(
            `Scheduled review: .zai.yml load failed for PR #${pr.number} (${repoConfigError?.message ?? String(repoConfigError)}); continuing without repo config.`,
          );
        }
        rawRepoConfig = {};
      }
    }
    const repoConfig = mergeRepoConfig(config, rawRepoConfig);
    if (Array.isArray(repoConfig.excludePatterns) && repoConfig.excludePatterns.length > 0) {
      patchable = filterExcludedFiles(patchable, repoConfig.excludePatterns);
      if (patchable.length === 0) {
        if (core?.info) {
          core.info(`Scheduled review: PR #${pr.number} — all patchable files excluded by .zai.yml path_filters; skipping.`);
        }
        // W15-A7-3 parity: the `pending` status was already posted above;
        // returning without a TERMINAL status would leave the check spinning
        // pending forever on a required-status repo. Post terminal `success`
        // (there is genuinely nothing to review) — same fail-soft helper, same
        // commitStatus gate as index.js.
        if (config.commitStatus) {
          await setReviewStatus(
            {
              octokit,
              context: ctx,
              sha: pr.headSha,
              state: 'success',
              description: 'No reviewable files (.zai.yml path_filters excluded all changes)',
            },
            { core },
          );
        }
        return { ok: true, action: 'skipped-no-patchable' };
      }
    }

    // W15-A8-4c: learnings / memory (`.zai/learnings.yml`) parity — mirrors
    // the push path. The file records "previously-reviewed / won't-fix"
    // patterns so the bot doesn't re-raise the same finding on every cron
    // tick. OPT-IN via config.learningsEnabled (the file is
    // attacker-controllable in fork PRs). loadLearnings is fail-soft by
    // contract (any error → [] + warning); a throwing injectable is guarded
    // here too. The accepted patterns ride the prompt (learningsContext) and
    // are applied as post-review suppression below.
    let learnings = [];
    if (config.learningsEnabled) {
      try {
        learnings = await loadLearnings(
          { octokit, context: ctx, headSha: pr.headSha },
          { core },
        );
      } catch (learningsError) {
        if (core?.warning) {
          core.warning(
            `Scheduled review: learnings load failed for PR #${pr.number} (${learningsError?.message ?? String(learningsError)}); continuing without learnings.`,
          );
        }
        learnings = [];
      }
    }
    const learningsContext = formatLearningsForPrompt(learnings);

    // W15-A8-4b: deterministic scanners run BEFORE the LLM (mirrors the push
    // path). Their findings become high-confidence findings (merged over LLM
    // findings at the same file:line+title inside runStructuredReview via
    // `deterministicFindings`) and are injected into the prompt as
    // "already detected, don't re-report" context via `scannerContext`. The
    // `.zai.yml` scanners map onto the orchestrator's per-scanner toggles
    // (gitleaks → secrets, ast_grep → patterns, metrics → metrics; the repo
    // can only DISABLE a scanner the action enabled — enforced by
    // mergeRepoConfig). runScanners is fail-soft by contract.
    const scannerRepoConfig = {
      scanners: {
        secrets: repoConfig.scanners?.gitleaks === false ? false : undefined,
        patterns: repoConfig.scanners?.ast_grep === false ? false : undefined,
        // W15-A1-2: `.zai.yml` `scanners.metrics: false` must reach the
        // orchestrator's per-scanner toggle — same mapping as index.js.
        metrics: repoConfig.scanners?.metrics === false ? false : undefined,
      },
    };
    const scannerResult = await runScanners({
      files: patchable,
      repoPath: process.cwd(),
      cacheDir: config.scannersCacheDir,
      config: { scannersEnabled: repoConfig.scannersEnabled },
      repoConfig: scannerRepoConfig,
    });
    const scannerContext = formatScannerContext(scannerResult.findings, scannerResult.metrics);
    if (scannerResult.scannerNames.length > 0 && core?.info) {
      core.info(
        `Scheduled review: PR #${pr.number} scanners: ${scannerResult.findings.length} finding(s) from ${scannerResult.scannerNames.join(', ')}.`,
      );
    }

    // W11-10: `largePrFileThreshold` used to be parsed in config, exported as
    // `isLargePr`, and wired through dependencies, but never called — a pure
    // config-wiring no-op (same class as W6-1/W6-2). Now we call it and log
    // when a PR exceeds the threshold, so the knob has an observable effect.
    // Batched review runs either way (batching handles both small and large
    // PRs), but the log line helps operators tune the threshold.
    if (typeof isLargePr === 'function' && isLargePr(patchable, { largePrFileThreshold: config.largePrFileThreshold })) {
      if (core?.info) {
        core.info(`Scheduled review: PR #${pr.number} is large (${patchable.length} patchable files > threshold ${config.largePrFileThreshold}); using batched review.`);
      }
    }

    const result = await runStructuredReview(
      patchable,
      {
        ...config,
        maxFindings: repoConfig.maxFindings,
        minSeverity: repoConfig.minSeverity ?? config.minSeverity,
        pathInstructions: repoConfig.pathInstructions,
        toneInstructions: repoConfig.toneInstructions,
        deterministicFindings: scannerResult.findings,
        scannerContext,
        learningsContext,
      },
      { callApi, core },
    );

    // W15-A8-4c: drop findings that match a previously-reviewed / won't-fix
    // learning (mirrors the push path; applied to the final findings set so the
    // posted review, the commit status, and the SHA-dedup hash all describe the
    // SAME kept set). When learningsEnabled is off (or nothing matched) this is
    // a no-op passthrough.
    const { kept: keptFindings } = filterFindingsByLearnings(result.findings, learnings);

    // W15-A8-4d: flip the commit status to `success` with a findings summary
    // now that the review completed. Mirrors index.js (W15-A6-2): computed from
    // the FINAL kept-findings set — AFTER learnings suppression — so the checks
    // tab never contradicts the posted review. Fail-soft.
    if (config.commitStatus) {
      const criticalCount = keptFindings.filter(
        (f) => f?.severity === 'critical',
      ).length;
      const highCount = keptFindings.filter(
        (f) => f?.severity === 'high',
      ).length;
      await setReviewStatus(
        {
          octokit,
          context: ctx,
          sha: pr.headSha,
          state: 'success',
          description: buildStatusDescription({
            findingCount: keptFindings.length,
            criticalCount,
            highCount,
          }),
        },
        { core },
      );
    }

    const { inline, summaryOnly } = partitionFindings(keptFindings, patchable);

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
      const event = resolveReviewEvent(keptFindings, config);
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
        // W12-1: pass the trusted trailers EXPLICITLY so postComment sanitizes
        // the body and re-appends only the known trusted trailers (marker +
        // SHA block). Without this, the trailers embedded in `body` would be
        // stripped by sanitizeModelOutput (W11-11), breaking idempotent upsert
        // and SHA-level dedup on the next run.
        const fallbackTrailers = [];
        const markerMatch = body.match(/<!--\s*zai-code-review\s*-->/);
        if (markerMatch) fallbackTrailers.push(markerMatch[0]);
        if (shaBlock) fallbackTrailers.push(shaBlock);
        await postFallbackComment({
          octokit,
          context: ctx,
          body: fallbackBody,
          trailers: fallbackTrailers,
        });
      }
      return { ok: true, action: 'reviewed' };
    }

    // No inline-mappable findings: post the whole summary as an issue comment
    // via the existing marker-upsert path (legacy summary comment). W15-A6-4:
    // mirror index.js — when walkthrough is on AND there are findings, render
    // the dependency-ordered walkthrough instead of the flat summary (previously
    // the scheduled path ALWAYS rendered flat, so cron and push runs disagreed
    // on the same PR). The metadata shape (summary prose carried to both
    // renderers) matches index.js's summary-only branch.
    const useWalkthrough =
      config.walkthrough && Array.isArray(keptFindings) && keptFindings.length > 0;
    const summaryMetadata = {
      deterministicFindingsCount: result.metadata.deterministicFindingsCount,
      truncated: Math.max(
        0,
        (result.metadata.totalFindingsBeforeCap || 0) - result.findings.length,
      ),
      summary: typeof result.summary === 'string' ? result.summary : '',
    };
    const content = useWalkthrough
      ? formatWalkthroughSummary(keptFindings, patchable, {
          reviewerName: config.reviewerName,
          metadata: summaryMetadata,
        })
      : formatFindingsAsSummary(keptFindings, {
          reviewerName: config.reviewerName,
          metadata: summaryMetadata,
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
 * @param {Function} [args.formatWalkthroughSummary]  Walkthrough renderer (W15-A6-4).
 * @param {Function} [args.loadRepoConfig]  .zai.yml loader (W15-A8-4a).
 * @param {Function} [args.mergeRepoConfig]  .zai.yml merge (W15-A8-4a).
 * @param {Function} [args.runScanners]  Scanner orchestrator (W15-A8-4b).
 * @param {Function} [args.formatScannerContext]  Scanner prompt context (W15-A8-4b).
 * @param {Function} [args.loadLearnings]  .zai/learnings.yml loader (W15-A8-4c).
 * @param {Function} [args.formatLearningsForPrompt]  Learnings prompt context (W15-A8-4c).
 * @param {Function} [args.filterFindingsByLearnings]  Learnings suppression (W15-A8-4c).
 * @param {Function} [args.setReviewStatus]  Commit-status poster (W15-A8-4d).
 * @param {Function} [args.buildStatusDescription]  Status description builder (W15-A8-4d).
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
  // W15-A6-4 walkthrough parity dep (optional; default: real renderer).
  formatWalkthroughSummary: formatWalkthroughSummaryFn = formatWalkthroughSummaryDefault,
  // W15-A8-4 feature-parity deps (optional; inert defaults — see reviewOnePr).
  loadRepoConfig = defaultLoadRepoConfig,
  mergeRepoConfig = defaultMergeRepoConfig,
  runScanners = defaultRunScanners,
  formatScannerContext = defaultFormatScannerContext,
  loadLearnings = defaultLoadLearnings,
  formatLearningsForPrompt = defaultFormatLearningsForPrompt,
  filterFindingsByLearnings = defaultFilterFindingsByLearnings,
  setReviewStatus = defaultSetReviewStatus,
  buildStatusDescription = buildStatusDescriptionDefault,
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
      formatWalkthroughSummary: formatWalkthroughSummaryFn,
      loadRepoConfig,
      mergeRepoConfig,
      runScanners,
      formatScannerContext,
      loadLearnings,
      formatLearningsForPrompt,
      filterFindingsByLearnings,
      setReviewStatus,
      buildStatusDescription,
    });

    if (result.ok) {
      // W15-A6-3: an ok result is not necessarily a REVIEW. reviewOnePr returns
      // {ok:true, action:'skipped-no-patchable'} for PRs with nothing to
      // review; counting those as reviewed made the log say "skipped-no-
      // patchable" while the summary said {reviewed:1}. Only real reviews count
      // as reviewed; skip-actions count as skipped.
      if (result.action === 'skipped-no-patchable') {
        skipped += 1;
      } else {
        reviewed += 1;
      }
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
