/**
 * Paginated PR-file fetch + pure file filters.
 *
 * Replaces the upstream action's hand-rolled pagination loop. Octokit is
 * INJECTED (parameter), never imported.
 */
import { matchesAnyPattern } from './glob.js';

/**
 * Fetch ALL changed files in a PR, paginating `pulls.listFiles`.
 *
 * Pages start at 1 and end as soon as a page returns fewer than `perPage`
 * items (the last page is short). Files without a `patch` (binary blobs or
 * diffs GitHub refuses to render) are still included; callers filter on
 * `.patch` via {@link filterPatchableFiles}.
 *
 * @param {object} args
 * @param {object} args.octokit    Octokit instance (rest.pulls.listFiles used).
 * @param {string} args.owner      Repository owner.
 * @param {string} args.repo       Repository name.
 * @param {number} args.pullNumber PR number.
 * @param {number} [args.perPage=100] Page size.
 * @returns {Promise<Array<{filename: string, status: string, patch?: string}>>}
 */
export async function getChangedFiles({ octokit, owner, repo, pullNumber, perPage = 100 }) {
  const all = [];
  let page = 1;
  for (;;) {
    const { data } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: perPage,
      page,
    });
    for (const file of data) {
      all.push(file);
    }
    if (data.length < perPage) {
      break;
    }
    page += 1;
  }
  return all;
}

/**
 * Keep only files with a non-empty string `patch`.
 *
 * @param {Array<{patch?: string}>} files
 * @returns {Array<{patch: string}>}
 */
export function filterPatchableFiles(files) {
  if (!Array.isArray(files)) return [];
  return files.filter((f) => typeof f?.patch === 'string' && f.patch.length > 0);
}

/**
 * Drop files whose `filename` matches any glob in `excludePatterns`.
 * Uses {@link matchesAnyPattern} from `./glob.js` (path + basename OR match).
 *
 * @param {Array<{filename: string}>} files
 * @param {string[]} excludePatterns
 * @returns {Array<{filename: string}>}
 */
export function filterExcludedFiles(files, excludePatterns) {
  if (!Array.isArray(files)) return [];
  return files.filter((f) => !matchesAnyPattern(f.filename, excludePatterns));
}
