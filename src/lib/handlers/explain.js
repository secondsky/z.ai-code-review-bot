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
import { postComment, getPRContext } from './_shared.js';
import { wrapUntrusted, escapeDiffFence } from '../prompt.js';
import { getChangedFiles } from '../changed-files.js';

/** Fixed error comment (no raw error leakage). */
const ERROR_COMMENT = '> ⚠️ Z.ai request failed. Please try again.';

/** Usage guidance. */
const USAGE_COMMENT =
  '> Usage: `/zai explain <start>-<end> [file]`\n> \n> Example: `/zai explain 10-20 src/index.js`';

/** Cap on the number of lines extracted into the explain prompt (cost guard). */
const MAX_WINDOW_LINES = 400;
/** Cap on the total chars of the extracted window (cost guard). */
const MAX_WINDOW_CHARS = 16000;

/** Separators accepted in a range token. */
const RANGE_SEPARATORS = ['-', ':', '..'];

/**
 * W15-A4-6: binary-content marker. A binary file under the 1MB contents-API
 * limit returns base64 that decodes to non-empty mojibake — U+FFFD
 * replacement chars (invalid UTF-8 byte sequences) and/or C0 control bytes.
 * Deliberately conservative: a SINGLE replacement char or a single C0
 * control char (excluding the whitespace controls \t \n \r) marks the file
 * as binary. Valid-UTF-8 text with accented/CJK characters never matches.
 */
const BINARY_CONTENT_RE = /\uFFFD|[\x00-\x08\x0E-\x1F]/;

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
      // CMD-3: strict numeric pre-check. `Number()` accepts hex (0x10),
      // scientific (1e3), decimals, and leading/trailing whitespace; reject
      // anything that is not a bare run of ASCII digits.
      if (!/^\d+$/.test(left) || !/^\d+$/.test(right)) return null;
      const start = Number(left);
      const end = Number(right);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
      if (start < 1 || end < 1 || end < start) return null;
      return { start, end };
    }
  }

  // CMD-3: strict numeric pre-check for the single-line form too.
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isSafeInteger(n) || n < 1) return null;
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
  // W2-SEC-4: the filename is attacker-controlled and is interpolated into a
  // backtick code span. A filename containing a backtick (e.g. weird`name.js)
  // would break out of the code span and inject prose into the instruction.
  // Sanitize via escapeDiffFence (replaces backticks with single quotes and
  // collapses newlines) — the same defense used for filename headers in the
  // structured-review prompt.
  const safeFile = escapeDiffFence(file);
  return [
    `Explain lines ${start}-${end} of \`${safeFile}\` in this pull request.`,
    'Describe what this code does, why it is there, and any concerns a',
    'reviewer should know about. Be concise.',
    '',
    wrapUntrusted(window, 'code-window'),
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
 * The PR head SHA is fetched via {@link getPRContext} (which calls
 * `octokit.rest.pulls.get`) rather than read from the `issue_comment` payload:
 * that payload has NO top-level `pull_request`, only the minimal
 * `payload.issue.pull_request` reference (no `head.sha`). Reading the payload
 * would always yield `undefined` and the handler would fall through to the
 * usage comment — so `/zai explain` would never reach `callApi`.
 *
 * @param {object} args  `{ octokit, context, config, core, commenter, args, callApi }`
 * @param {object} [deps={}]
 * @param {(o: object) => Promise<*>} [deps.post]
 * @param {(o: object) => Promise<Array>} [deps.getChangedFiles]
 * @param {(o: object) => Promise<string>} [deps.fetchFileContent]
 * @param {(o: object) => Promise<{headSha?: string}|null>} [deps.getPRContext]
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
    getPRContext: getCtx = (o) => getPRContext(o),
  } = deps;

  const owner = context?.repo?.owner;
  const repo = context?.repo?.repo;
  const pullNumber = context?.payload?.issue?.number;

  const { range, file } = parseExplainArgs(args);

  try {
    // W16-B4-2: this post (like every other in the handler) must be inside
    // the try — it previously executed OUTSIDE it, so a transient 502 on this
    // single createComment rejected the whole handler and failed the entire
    // action (the router dispatches with no catch).
    if (!range) {
      await post(USAGE_COMMENT);
      return;
    }

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

    // Fetch the head SHA via the API: the issue_comment payload does NOT carry
    // it (no top-level pull_request.head.sha).
    const pr = await getCtx({ octokit, context });
    const ref = pr?.headSha;
    if (typeof ref !== 'string' || ref === '') {
      // Without the head sha we can't fetch a stable file snapshot.
      await post(USAGE_COMMENT);
      return;
    }

    const content = await fetch({ octokit, owner, repo, path: target, ref });
    // CMD-12: when the file has no textual content (binary file, directory
    // entry, or a file too large for the API to return), post a guidance
    // comment instead of calling the API with an empty code window.
    if (!content || content.trim() === '') {
      await post(`> No textual content available for \`${target}\`.`);
      return;
    }
    // Clamp the requested range to a sane window so a `/zai explain 1-50000`
    // on a huge file cannot build a giant prompt (cost/quota guard). The
    // visible range reported to the model reflects the clamp.
    const clampedEnd = Math.min(range.end, range.start + MAX_WINDOW_LINES - 1);
    let window = extractLineWindow(content, range.start, clampedEnd);
    // W15-A4-1: CMD-12 only guarded whole-file emptiness. A range entirely
    // past EOF on a non-empty file (e.g. 5000-5001 on a 5-line file) yields an
    // EMPTY window here — sending that to the API invites the model to
    // hallucinate the requested lines. Post guidance instead.
    if (window.trim() === '') {
      const lines = content.split('\n');
      const lineCount =
        lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
      await post(
        `> No lines in range ${range.start}-${range.end} — \`${target}\` has ${lineCount} line${lineCount === 1 ? '' : 's'}.`,
      );
      return;
    }
    // W15-A4-6 / W16-B4-1: a binary file UNDER the 1MB API limit decodes to
    // non-empty mojibake (replacement chars / C0 controls) — post guidance,
    // no callApi. The detector runs on the EXTRACTED WINDOW, not the whole
    // file: previously a single legal control char anywhere in the file
    // (e.g. \x01 on line 50 of a 100-line text fixture) disabled /zai explain
    // for every clean range with a wrong "No textual content" message.
    // Scoping to the window keeps clean ranges working while any window of a
    // UTF-16 file (decoded as UTF-8 → NUL bytes) is still caught.
    if (BINARY_CONTENT_RE.test(window)) {
      await post(
        `> No textual content available for lines ${range.start}-${clampedEnd} of \`${target}\`.`,
      );
      return;
    }
    if (window.length > MAX_WINDOW_CHARS) {
      window = window.slice(0, MAX_WINDOW_CHARS);
    }
    const prompt = buildExplainPrompt({
      file: target,
      start: range.start,
      end: clampedEnd,
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
