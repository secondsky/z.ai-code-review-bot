/**
 * Centralized prompt strings — the single source of truth for the built-in
 * default system prompt and shared prompt builders.
 *
 * No command-specific prompt builders live here (YAGNI); handlers own those.
 */

/** Built-in default system prompt (used when the caller provides none). */
export const DEFAULT_SYSTEM_PROMPT =
  'You are an expert code reviewer. Review the provided pull-request changes and give clear, actionable feedback. Focus on concrete bugs, security issues, risky logic, and architecture mismatches. Skip trivial style comments.';

/** Fixed instruction header prepended to every auto-review user message. */
const AUTO_REVIEW_HEADER =
  'Please review the following pull request changes and provide concise, constructive feedback. Focus on bugs, logic errors, security issues, and meaningful improvements. Skip trivial style comments.';

/** Truncation note appended when the diff exceeds `maxDiffChars`. */
const TRUNCATION_NOTE =
  '\n\n> **Note:** The diff exceeded the MAX_DIFF_CHARS limit and was truncated.';

/**
 * Resolve the effective system prompt: returns the caller-supplied prompt if
 * non-empty (after trim), otherwise {@link DEFAULT_SYSTEM_PROMPT}. Tolerant of
 * missing or nullish `config`.
 *
 * @param {{systemPrompt?: string}} [config]
 * @returns {string}
 */
export function resolveSystemPrompt(config) {
  const sp = config?.systemPrompt;
  if (typeof sp === 'string' && sp.trim() !== '') {
    return sp;
  }
  return DEFAULT_SYSTEM_PROMPT;
}

/**
 * Format a single patchable file as a diff block entry.
 *
 * @param {{filename: string, status: string, patch: string}} f
 * @returns {string}
 */
function formatFileEntry(f) {
  return `### ${f.filename} (${f.status})\n\`\`\`diff\n${f.patch}\n\`\`\``;
}

/**
 * Build the user-message prompt for auto-review of a list of changed files.
 *
 * Files without a usable `patch` are skipped defensively (callers normally
 * filter first via {@link filterPatchableFiles}). Empty/undefined input
 * returns just the instruction header.
 *
 * If `options.maxDiffChars > 0` and the joined result exceeds the limit, files
 * are dropped from the END (trailing entries removed) until the body fits, and
 * a fixed truncation note is appended. `maxDiffChars === 0` disables truncation.
 *
 * @param {Array<{filename: string, status: string, patch?: string}>} [files]
 * @param {{maxDiffChars?: number}} [options]
 * @returns {string}
 */
export function buildAutoReviewPrompt(files, options = {}) {
  const header = AUTO_REVIEW_HEADER;
  if (!Array.isArray(files) || files.length === 0) {
    return header;
  }

  const entries = files
    .filter((f) => f && typeof f.patch === 'string' && f.patch.length > 0)
    .map(formatFileEntry);

  if (entries.length === 0) {
    return header;
  }

  const maxDiffChars = typeof options.maxDiffChars === 'number' ? options.maxDiffChars : 0;

  if (maxDiffChars > 0) {
    const patchable = files.filter(
      (f) => f && typeof f.patch === 'string' && f.patch.length > 0,
    );
    // Truncate from the END: drop trailing entries until the joined body fits
    // within maxDiffChars (the note is appended AFTER, outside the cap).
    while (entries.length > 0) {
      const body = `${header}\n\n${entries.join('\n\n')}`;
      if (body.length <= maxDiffChars) {
        break;
      }
      entries.pop();
    }
    const body = `${header}\n\n${entries.join('\n\n')}`;
    // If we kept fewer files than originally, this was a truncation event.
    if (entries.length < patchable.length) {
      return `${body}${TRUNCATION_NOTE}`;
    }
    return body;
  }

  return `${header}\n\n${entries.join('\n\n')}`;
}
