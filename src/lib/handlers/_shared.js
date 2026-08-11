/**
 * Shared helpers used by every `/zai` command handler.
 *
 * Two small, defensive wrappers around the injected octokit:
 *   - `postComment`     → create an issue comment (command response).
 *   - `getPRContext`    → fetch minimal PR metadata for prompt-building.
 *
 * Both are defensive on a missing/malformed `context`: they return a sane
 * sentinel (`null`) rather than throwing, so a handler that calls them can
 * decide how to degrade (typically: post a short guidance/error comment and
 * return). Octokit is ALWAYS a parameter — never imported — so this module
 * stays pure and unit-testable.
 *
 * No handler imports `@actions/core` or hits the network directly.
 */

import { sanitizeModelOutput } from '../sanitize-output.js';

/**
 * Markers delimiting the upserted PR-description block. The block is the ONLY
 * region of the PR body that Z.ai ever mutates (when ZAI_DESCRIBE_WRITE_BODY is
 * enabled). Everything outside the markers is preserved verbatim.
 */
export const DESCRIBE_MARKER_START = '<!-- zai-description -->';
export const DESCRIBE_MARKER_END = '<!-- /zai-description -->';

/**
 * Post a command-response comment on the PR/issue.
 *
 * Uses `octokit.rest.issues.createComment` (a PLAIN create, NOT the marker
 * upsert from comments.js — each command gets its OWN comment, distinct from
 * the auto-review summary marker).
 *
 * The `body` is run through `sanitizeModelOutput` before posting so an
 * indirect prompt-injection cannot coax the bot into emitting @mention spam or
 * forged GitHub alert banners under its trusted identity. Static/usage text
 * (e.g. the help table) is untouched by the sanitizer.
 *
 * `owner`/`repo` come from `context.repo`; `issue_number` from
 * `context.payload.issue.number` (issue_comment events carry the issue number
 * which equals the PR number).
 *
 * @param {object} args
 * @param {object} args.octokit   Octokit instance.
 * @param {object} args.context   @actions/github context (or same shape).
 * @param {string} args.body      Comment body (will be sanitized before posting).
 * @returns {Promise<object|null>}  The created comment data, or `null` if the
 *   context was missing the fields needed to post (defensive no-op).
 */
export async function postComment({ octokit, context, body }) {
  const owner = context?.repo?.owner;
  const repo = context?.repo?.repo;
  const issueNumber = context?.payload?.issue?.number;
  if (!owner || !repo || typeof issueNumber !== 'number') {
    return null;
  }
  // W11-11: sanitizeModelOutput strips ALL zai-* HTML comments (the forgeries
  // we defend against come from MODEL output). But the fallback-review path
  // embeds TRUSTED trailers assembled by our own code — the idempotency marker
  // (<!-- zai-code-review -->), the incremental-review hash block
  // (<!-- zai-hashes: ... -->), and the schedule-dedup SHA block
  // (<!-- zai-sha: ... -->). Stripping those breaks idempotent upsert on the
  // next run and defeats SHA-level dedup.
  //
  // The trusted trailers are always appended by `appendTrailers` AFTER the
  // body prose, so they form a contiguous tail of zai-* comments. A model
  // forgery can appear ANYWHERE in the prose. So we split the body into a
  // prose region (sanitized, forgeries stripped) and a trailing-trailer
  // region (trusted, preserved), and reassemble. This never preserves a
  // forgery embedded in the prose — only the contiguous tail of zai-* comments
  // that our own code appended.
  let prose = typeof body === 'string' ? body : '';
  let trailers = '';
  if (prose) {
    // Capture the trailing run of `<!-- zai-* -->` comments (each optionally
    // preceded by a newline), working backwards from the end.
    const tailRe = /(\s*<!--\s*zai-[^\n>]*-->)+\s*$/;
    const tailMatch = prose.match(tailRe);
    if (tailMatch) {
      trailers = tailMatch[0];
      prose = prose.slice(0, tailMatch.index);
    }
  }
  let safeBody = sanitizeModelOutput(prose);
  if (trailers) {
    safeBody = `${safeBody.replace(/\n+$/, '')}${trailers}`;
  }
  const { data } = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: safeBody,
  });
  return data;
}

/**
 * Fetch minimal PR metadata for prompt-building.
 *
 * Returns `{ title, body, headBranch, baseBranch, headSha }` via
 * `octokit.rest.pulls.get({ owner, repo, pull_number })` where `pull_number`
 * is `context.payload.issue.number`. Keeps the payload minimal on purpose —
 * per-file fetching is the caller's job (each handler fetches what it needs).
 *
 * `headSha` is exposed so handlers can fetch a stable file snapshot via
 * `repos.getContent` without trusting the `issue_comment` payload, which does
 * NOT carry the PR head SHA (only `payload.issue.pull_request`, a minimal
 * reference with no `head.sha`).
 *
 * Defensive: returns `null` (and fetches nothing) when context is missing the
 * owner/repo/issue-number fields.
 *
 * @param {object} args
 * @param {object} args.octokit
 * @param {object} args.context
 * @returns {Promise<{title: string, body: string, headBranch: string, baseBranch: string, headSha: string}|null>}
 */
export async function getPRContext({ octokit, context }) {
  const owner = context?.repo?.owner;
  const repo = context?.repo?.repo;
  const pullNumber = context?.payload?.issue?.number;
  if (!owner || !repo || typeof pullNumber !== 'number') {
    return null;
  }
  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });
  return {
    title: typeof data?.title === 'string' ? data.title : '',
    body: typeof data?.body === 'string' ? data.body : '',
    headBranch: data?.head?.ref ?? '',
    baseBranch: data?.base?.ref ?? '',
    headSha: data?.head?.sha ?? '',
    // Fork status is exposed so the router can resolve fork-ness on the
    // issue_comment command path (where the payload does NOT carry it).
    isFork: data?.head?.repo?.fork === true,
  };
}

/**
 * Upsert a marked description block into the PR body via `pulls.update`.
 *
 * - If a `<!-- zai-description -->` … `<!-- /zai-description -->` block already
 *   exists, its CONTENTS are replaced; everything outside the markers is
 *   preserved verbatim (never destroys human-written body text).
 * - Otherwise the marked block is appended to the existing body.
 *
 * This is the opt-in mutation behind `ZAI_DESCRIBE_WRITE_BODY` (default off).
 * Requires `pull-requests: write`.
 *
 * @param {object} args `{ octokit, owner, repo, pullNumber, description }`
 * @param {object} [deps]
 * @param {Function} [deps.getPr]  Injected `pulls.get` (default: real).
 * @param {Function} [deps.updatePr]  Injected `pulls.update` (default: real).
 * @returns {Promise<{updated: boolean}>}
 */
export async function upsertPrDescription(
  { octokit, owner, repo, pullNumber, description },
  deps = {},
) {
  const getPr =
    deps.getPr ||
    ((o) => octokit.rest.pulls.get(o).then((r) => r.data));
  const updatePr =
    deps.updatePr ||
    ((o) => octokit.rest.pulls.update(o));

  const pr = await getPr({ owner, repo, pull_number: pullNumber });
  const currentBody = typeof pr?.body === 'string' ? pr.body : '';
  // CMD-8: strip any model-emitted marker strings from the description before
  // interpolating, so an indirect prompt-injection cannot break out of the
  // upsert block or duplicate the markers.
  const safeDescription = String(description ?? '').replace(
    /<!--\s*\/?zai-description\s*-->/g,
    '',
  );
  const block = `${DESCRIBE_MARKER_START}\n${safeDescription}\n${DESCRIBE_MARKER_END}`;

  let newBody;
  const startIdx = currentBody.indexOf(DESCRIBE_MARKER_START);
  if (startIdx !== -1) {
    const endIdx = currentBody.indexOf(DESCRIBE_MARKER_END, startIdx);
    if (endIdx !== -1) {
      // Replace the existing block's contents; preserve text before & after.
      newBody =
        currentBody.slice(0, startIdx) +
        block +
        currentBody.slice(endIdx + DESCRIBE_MARKER_END.length);
    } else {
      // CMD-7: orphan start marker (start without a matching end). Treat as
      // "no block found" and append, instead of slicing everything after the
      // orphan marker (which would destroy human-written body text).
      // W11-7: STRIP the orphan marker(s) before appending. Without this, the
      // body carries a dangling START; the NEXT run finds it via indexOf(START)
      // and pairs it with the appended block's END, so the in-place replace
      // spans the whole gap and deletes the human-written text between them.
      const stripped = currentBody
        .replace(/<!--\s*\/?zai-description\s*-->\n?/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trimEnd();
      newBody = stripped ? `${stripped}\n\n${block}` : block;
    }
  } else if (currentBody.includes(DESCRIBE_MARKER_END)) {
    // Orphan END marker (end without a matching start). Strip it and append.
    const stripped = currentBody
      .replace(/<!--\s*\/?zai-description\s*-->\n?/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd();
    newBody = stripped ? `${stripped}\n\n${block}` : block;
  } else {
    // No existing block: append.
    newBody = currentBody ? `${currentBody}\n\n${block}` : block;
  }

  await updatePr({ owner, repo, pull_number: pullNumber, body: newBody });
  return { updated: true };
}
