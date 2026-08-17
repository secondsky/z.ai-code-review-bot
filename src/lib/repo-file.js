/**
 * Shared repo-file loader — the single home for the fetch + base64-decode +
 * dual-size-cap pipeline that `codeowners.js`, `learnings.js`, and
 * `repo-config.js` each used to duplicate with DRIFTED conventions (F-REPOFILE).
 *
 * Both helpers are untrusted-input boundaries: every file fetched from a fork
 * PR's head SHA is ATTACKER-CONTROLLABLE, so the pipeline hard-caps what it
 * will decode (`maxBytes`, checked against the reported byte size AND the
 * decoded length) and never trusts the shape of the API response.
 *
 * `fetchRepoText` does NOT throw for fetch/size/decode problems — it returns a
 * discriminated outcome so each caller can map `missing` / `too-large` /
 * `decode` / `error` onto its own pinned warning shape:
 *
 *   { ok: true,  text }
 *   { ok: false, kind: 'missing' | 'too-large' | 'decode' | 'error', message }
 *
 * `label` prefixes every `message` (e.g. `learnings: …`) so callers can warn
 * with the outcome message verbatim and keep their historical warning strings.
 * Payload conventions (the learnings/repo-config superset, now adopted
 * everywhere, including codeowners):
 *   - `{ content: <base64>, encoding: 'base64' }` — decoded, whitespace stripped
 *   - a raw string `data` — used as the text directly
 *   - anything else (directory listing, symlink, empty body) — `missing`
 *
 * @module src/lib/repo-file.js
 */

/**
 * Resolve the PR head SHA from `opts.headSha` or
 * `context.payload.pull_request.head.sha`.
 *
 * @param {Object} opts
 * @returns {string}
 */
export function resolveHeadSha(opts) {
  if (typeof opts.headSha === 'string' && opts.headSha !== '') return opts.headSha;
  const sha = opts.context?.payload?.pull_request?.head?.sha;
  return typeof sha === 'string' ? sha : '';
}

/**
 * Fetch a single text file from the repo at `ref` and decode it, with both
 * size caps applied. Never throws for fetch/size/decode failures — the outcome
 * discriminates them.
 *
 * @param {Object} args
 * @param {object} args.octokit   octokit instance (`rest.repos.getContent`).
 * @param {string} args.owner     repo owner.
 * @param {string} args.repo      repo name.
 * @param {string} args.path      repo-relative path to fetch.
 * @param {string} args.ref       git ref (typically the PR head SHA).
 * @param {number} args.maxBytes  hard cap applied to the reported byte size
 *                                AND the decoded char length.
 * @param {string} args.label     message prefix (e.g. `learnings`).
 * @returns {Promise<{ok: true, text: string} |
 *                   {ok: false, kind: 'missing'|'too-large'|'decode'|'error', message: string}>}
 */
export async function fetchRepoText({ octokit, owner, repo, path, ref, maxBytes, label }) {
  const shortRef = typeof ref === 'string' ? ref.slice(0, 7) : String(ref ?? '');

  let data;
  try {
    const resp = await octokit.rest.repos.getContent({ owner, repo, path, ref });
    data = resp?.data;
  } catch (error) {
    const status = error?.status;
    if (status === 404) {
      return {
        ok: false,
        kind: 'missing',
        message: `${label}: no ${path} found at ${shortRef} (404).`,
      };
    }
    return {
      ok: false,
      kind: 'error',
      message: `${label}: failed to fetch ${path} (${status ?? 'unknown'}): ${
        error?.message ?? String(error)
      }`,
    };
  }

  if (data && typeof data.content === 'string') {
    // Reject oversized content before decoding (cost/DoS guard). `data.size`
    // is the byte count GitHub reports; fall back to the base64 length when
    // missing.
    const size = typeof data.size === 'number' ? data.size : data.content.length;
    if (size > maxBytes) {
      return {
        ok: false,
        kind: 'too-large',
        message: `${label}: ${path} is ${size} bytes (cap ${maxBytes}); skipping.`,
      };
    }
    let text;
    try {
      text = Buffer.from(data.content.replace(/\s/g, ''), 'base64').toString('utf8');
    } catch {
      return {
        ok: false,
        kind: 'decode',
        message: `${label}: ${path} could not be base64-decoded; skipping.`,
      };
    }
    // Post-decode size guard (`data.size` can under-report).
    if (typeof text === 'string' && text.length > maxBytes) {
      return {
        ok: false,
        kind: 'too-large',
        message: `${label}: ${path} decodes to ${text.length} chars (cap ${maxBytes}); skipping.`,
      };
    }
    return { ok: true, text };
  }

  if (typeof data === 'string') {
    // Raw-string payload (non-base64 response) — use it directly.
    if (data.length > maxBytes) {
      return {
        ok: false,
        kind: 'too-large',
        message: `${label}: ${path} is ${data.length} chars (cap ${maxBytes}); skipping.`,
      };
    }
    return { ok: true, text: data };
  }

  // Not a file (directory listing or symlink) — treat as missing.
  return { ok: false, kind: 'missing', message: `${label}: ${path} is not a file` };
}
