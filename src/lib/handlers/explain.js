/**
 * `/zai explain <range> [file]` — explain a line range.
 *
 * `args` is a line range like `10-20`, `10:20`, `10..20`, or a single `N`
 * (start=end=N), optionally followed by a file path. If no file is given, the
 * first changed file is used (or a usage comment if there are none).
 *
 * The requested line window is extracted from the file content at the PR head
 * (via `octokit.rest.repos.getContent`) and an "explain these lines" prompt is
 * sent to the injected `callApi`.
 *
 * Contract invariants: same `deps = {}` seam; same injected `callApi`; NEVER
 * throws; no `@actions/core` import; no direct network.
 */
import { postComment } from './_shared.js';
import { getChangedFiles } from '../changed-files.js';

/** Fixed error comment (no raw error leakage). */
const ERROR_COMMENT = '> ⚠️ Z.ai request failed. Please try again.';

/** Usage guidance. */
const USAGE_COMMENT =
  '> Usage: `/zai explain <start>-<end> [file]`\n> \n> Example: `/zai explain 10-20 src/index.js`';

/** Separators accepted in a range token. */
const RANGE_SEPARATORS = ['-', ':', '..'];

/**
 * Parse a range token into `{ start, end }`.
 *
 * Accepts `N-M`, `N:M`, `N..M`; a single `N` → `{ start: N, end: N }`.
 * Returns `null` for non-numeric input, `end < start`, or empty input.
 *
 * Pure (exported for testing).
 *
 * @param {string} token
 * @returns {{start: number, end: number}|null}
 */
export function parseRange(token) {
  if (typeof token !== 'string') return null;
  const t = token.trim();
  if (t === '') return null;

  for (const sep of RANGE_SEPARATORS) {
    if (t.includes(sep)) {
      const idx = t.indexOf(sep);
      const left = t.slice(0, idx);
      const right =
        sep === '..' ? t.slice(idx + 2) : t.slice(idx + sep.length);
      const start = Number(left);
      const end = Number(right);
      if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
      if (start < 1 || end < 1 || end < start) return null;
      return { start, end };
    }
  }

  const n = Number(t);
  if (!Number.isInteger(n) || n < 1) return null;
  return { start: n, end: n };
}

/**
 * Parse the full `/zai explain` args into `{ range, file }`.
 *
 * The first whitespace-delimited token is the range; if a second token exists,
 * it is the file path. Returns `{ range: null, file: null }` when the args are
 * empty or the range is invalid. Pure (exported for testing).
 *
 * @param {string} args
 * @returns {{range: {start: number, end: number}|null, file: string|null}}
 */
export function parseExplainArgs(args) {
  const trimmed = typeof args === 'string' ? args.trim() : '';
  if (trimmed === '') return { range: null, file: null };
  const parts = trimmed.split(/\s+/);
  const range = parseRange(parts[0]);
  if (!range) return { range: null, file: null };
  const file = parts.length > 1 ? parts.slice(1).join(' ') : null;
  return { range, file };
}

/**
 * Extract a 1-indexed line window `[start, end]` from `content`.
 *
 * Pure (exported for testing).
 *
 * @param {string} content
 * @param {number} start  1-indexed inclusive.
 * @param {number} end    1-indexed inclusive.
 * @returns {string}  the numbered lines in the window.
 */
export function extractLineWindow(content, start, end) {
  const text = typeof content === 'string' ? content : '';
  const lines = text.split('\n');
  const out = [];
  for (let i = start; i <= end; i++) {
    const line = lines[i - 1];
    if (line === undefined) break;
    out.push(`${i}: ${line}`);
  }
  return out.join('\n');
}

/**
 * Build the explain USER prompt. Pure (exported for testing).
 *
 * @param {object} p
 * @param {string} p.file
 * @param {number} p.start
 * @param {number} p.end
 * @param {string} p.window
 * @returns {string}
 */
export function buildExplainPrompt({ file, start, end, window }) {
  return [
    `Explain lines ${start}-${end} of \`${file}\` in this pull request.`,
    'Describe what this code does, why it is there, and any concerns a',
    'reviewer should know about. Be concise.',
    '',
    '```',
    window,
    '```',
  ].join('\n');
}

/**
 * Fetch a file's text content at the PR head ref. Decodes base64 when the API
 * returns `content` (the typical shape); returns `''` defensively.
 *
 * @param {object} args  `{ octokit, owner, repo, path, ref }`
 * @returns {Promise<string>}
 */
async function fetchFileContent({ octokit, owner, repo, path, ref }) {
  const { data } = await octokit.rest.repos.getContent({
    owner,
    repo,
    path,
    ref,
  });
  if (typeof data?.content === 'string') {
    // GitHub returns base64-encoded content with newlines every 76 chars.
    try {
      return Buffer.from(data.content.replace(/\s/g, ''), 'base64').toString(
        'utf8',
      );
    } catch {
      return data.content;
    }
  }
  if (typeof data === 'string') return data;
  return '';
}

/**
 * Handle `/zai explain`.
 *
 * @param {object} args  `{ octokit, context, config, core, commenter, args, callApi }`
 * @param {object} [deps={}]
 * @param {(o: object) => Promise<*>} [deps.post]
 * @param {(o: object) => Promise<Array>} [deps.getChangedFiles]
 * @param {(o: object) => Promise<string>} [deps.fetchFileContent]
 * @returns {Promise<void>}
 */
export async function handleExplainCommand(
  { octokit, context, config = {}, core, commenter, args, callApi } = {},
  deps = {},
) {
  const {
    post = (body) => postComment({ octokit, context, body }),
    getChangedFiles: getFiles = (o) => getChangedFiles(o),
    fetchFileContent: fetch = (o) => fetchFileContent(o),
  } = deps;

  const owner = context?.repo?.owner;
  const repo = context?.repo?.repo;
  const pullNumber = context?.payload?.issue?.number;
  const ref = context?.payload?.pull_request?.head?.sha;

  const { range, file } = parseExplainArgs(args);
  if (!range) {
    await post(USAGE_COMMENT);
    return;
  }

  try {
    const files =
      typeof pullNumber === 'number'
        ? await getFiles({ octokit, owner, repo, pullNumber })
        : [];
    const filenames = (files || [])
      .map((f) => f?.filename)
      .filter((f) => typeof f === 'string');

    let target = file;
    if (!target) {
      target = filenames[0];
      if (!target) {
        await post(USAGE_COMMENT);
        return;
      }
    } else if (!filenames.includes(target)) {
      await post(`> File \`${target}\` is not part of this PR.`);
      return;
    }

    if (typeof ref !== 'string') {
      // Without the head sha we can't fetch a stable file snapshot.
      await post(USAGE_COMMENT);
      return;
    }

    const content = await fetch({ octokit, owner, repo, path: target, ref });
    const window = extractLineWindow(content, range.start, range.end);
    const prompt = buildExplainPrompt({
      file: target,
      start: range.start,
      end: range.end,
      window,
    });
    const explanation = await callApi(config.apiKey, config.model, prompt);
    await post(explanation);
  } catch (error) {
    if (core?.warning) {
      core.warning(`explain handler failed: ${error?.message ?? error}`);
    }
    try {
      await post(ERROR_COMMENT);
    } catch {
      /* last-resort: never throw out of the handler. */
    }
  }
}
