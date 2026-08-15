/**
 * Code-pattern detection: ast-grep (preferred) + a line-based regex fallback.
 *
 * Architecture — the injection seam:
 *   - `deps.runBinary(args, opts)` shells out to the real `ast-grep` binary in
 *     production; tests inject a fake that returns canned JSON.
 *   - `deps.ensureBinary(spec, deps)` fetches+verifies+caches the ast-grep
 *     binary in production; tests inject a fake that returns a fake path.
 *   - On ANY error (binary unavailable, exec failure, parse failure), the
 *     scanner falls back to `scanPatternsRegex(files, rules)` (pure, no I/O)
 *     and warns via `deps.core.warning`.
 *
 * The regex fallback is exported for direct testing — it's the high-value
 * pure logic, fully unit-testable without any binaries.
 *
 * @module src/lib/scanners/patterns.js
 */

import os from 'node:os';
import nodePath from 'node:path';
import { parseAddedLines, changedFileNames } from './_patch.js';
import { selectPlatformAsset, zipExtractor } from './ensure-binary.js';

/* ------------------------------------------------------------------ *
 * Default curated rules
 * ------------------------------------------------------------------ */

/**
 * The default ast-grep rule set. Each rule: `{ id, pattern, severity, category,
 * languages, title, description?, suggestion? }`.
 *
 * - `pattern` is an ast-grep pattern (`$$$` = multi-node wildcard, `$X` =
 *   single-node wildcard). For the regex fallback, the pattern is converted to
 *   a substring/regex match (less precise).
 * - `languages` is the ast-grep language hint; `'*'` means "any language"
 *   (line-based match in the fallback).
 *
 * @type {Array<Object>}
 */
export const DEFAULT_PATTERN_RULES = [
  {
    id: 'eval',
    pattern: 'eval($$$ARGS)',
    severity: 'high',
    category: 'security',
    languages: ['js', 'ts', 'jsx', 'tsx'],
    title: 'Use of eval()',
    description: '`eval()` executes arbitrary strings as code, enabling injection attacks.',
    suggestion: 'Avoid eval(); parse with JSON.parse or use a safe expression evaluator.',
  },
  {
    id: 'innerHTML',
    pattern: 'innerHTML = $VALUE',
    severity: 'medium',
    category: 'security',
    languages: ['js', 'ts', 'jsx', 'tsx'],
    title: 'innerHTML assignment (XSS risk)',
    description:
      'Assigning to innerHTML with untrusted content can execute injected scripts (XSS).',
    suggestion: 'Use textContent or sanitize the input before assigning to innerHTML.',
  },
  {
    id: 'dangerouslySetInnerHTML',
    // The brief wrote `{$$$` (truncated); using `{$$$}` — a multi-node wildcard
    // inside the JSX expression braces — which catches `={{__html: x}}` and
    // `{x}` alike.
    pattern: 'dangerouslySetInnerHTML={$$$}',
    severity: 'medium',
    category: 'security',
    languages: ['jsx', 'tsx'],
    title: 'dangerouslySetInnerHTML usage',
    description:
      'React\'s dangerouslySetInnerHTML bypasses escaping; only safe with sanitized input.',
    suggestion: 'Sanitize the HTML with DOMPurify before rendering.',
  },
  {
    id: 'exec',
    pattern: 'child_process.exec($CMD)',
    severity: 'high',
    category: 'security',
    languages: ['js', 'ts'],
    title: 'child_process.exec with possible user input',
    description:
      'child_process.exec runs through a shell, allowing shell-injection when the ' +
      'command includes untrusted input.',
    suggestion:
      'Use child_process.execFile (no shell) or shell-escape the input with a lib like shell-quote.',
  },
  {
    id: 'tls-reject-unauthorized',
    pattern: 'rejectUnauthorized: false',
    severity: 'high',
    category: 'security',
    languages: ['js', 'ts'],
    title: 'TLS certificate verification disabled',
    description:
      'Setting rejectUnauthorized:false disables TLS verification, enabling MITM attacks.',
    suggestion: 'Remove rejectUnauthorized:false or pin a custom CA bundle instead.',
  },
  {
    id: 'sql-concat',
    pattern: '$CONN.query("$$$" + $VAR)',
    severity: 'high',
    category: 'security',
    languages: ['js', 'ts'],
    title: 'SQL query via string concatenation (injection risk)',
    description:
      'Concatenating variables into a SQL query string allows SQL injection.',
    suggestion: 'Use parameterized queries / prepared statements.',
  },
  {
    id: 'todo-in-code',
    pattern: 'TODO',
    severity: 'info',
    category: 'maintainability',
    languages: ['*'],
    title: 'TODO left in code',
    description: 'A TODO marker was added in the diff.',
    suggestion: 'Resolve the TODO or track it in an issue.',
  },
  {
    id: 'fixme-in-code',
    pattern: 'FIXME',
    severity: 'info',
    category: 'maintainability',
    languages: ['*'],
    title: 'FIXME left in code',
    description: 'A FIXME marker was added in the diff.',
    suggestion: 'Resolve the FIXME or track it in an issue.',
  },
  {
    id: 'console-log',
    pattern: 'console.log($$$ARGS)',
    severity: 'low',
    category: 'maintainability',
    languages: ['js', 'ts', 'jsx', 'tsx'],
    title: 'console.log left in code',
    description:
      'A console.log statement was added; debug logging shouldn\'t ship to production.',
    suggestion: 'Remove the console.log or route through a leveled logger.',
  },
];

/* ------------------------------------------------------------------ *
 * Pure regex fallback
 * ------------------------------------------------------------------ */

/**
 * Convert an ast-grep rule `pattern` into a regex for line-based matching.
 * The translation is intentionally simple:
 *   - `$$$ARGS`, `$$$`, `$VALUE`, `$X`, `$VAR`, etc. → `.*?` (non-greedy any)
 *   - regex metacharacters in the literal portions are escaped, EXCEPT for
 *     `{`, `}`, `(`, `)`, which are common structural chars in ast-grep
 *     patterns (e.g. `eval($$$ARGS)`, `dangerouslySetInnerHTML={$$$}`) and
 *     behave identically escaped-or-not in modern JS regex when not forming
 *     a quantifier.
 *
 * Implementation note: the wildcard tokens are replaced with placeholder
 * strings BEFORE escaping (so the inserted `.`, `*`, `?` don't get escaped),
 * then the placeholders are turned into `.*?` AFTER escaping. This avoids
 * double-handling of the wildcard chars.
 *
 * This is much less precise than a real AST walk — it only catches the obvious
 * cases — but it works on any text file without a parser and never throws.
 *
 * Returns a RegExp (case-sensitive) or `null` if the pattern cannot be
 * translated.
 *
 * @param {string} pattern
 * @returns {RegExp | null}
 */
export function astGrepPatternToRegex(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) return null;
  // Step 1: replace wildcard tokens with an unlikely placeholder.
  const PLACEHOLDER = '\u0000WILD\u0000';
  // SCN-8: collapse runs of literal whitespace to a separate placeholder so the
  // final regex uses `\s*` instead of literal spaces (catches `innerHTML=x` as
  // well as `innerHTML = x`). `\s*` (zero-or-more) is used so the unspaced
  // form still matches. Done BEFORE escaping so the inserted chars aren't
  // escaped; the placeholder carries no regex metachars.
  const WS_PLACEHOLDER = '\u0000WS\u0000';
  let translated = pattern
    .replace(/\$\$\$[A-Z]*/g, PLACEHOLDER) // $$$ARGS, $$$
    .replace(/\$[A-Z]+/g, PLACEHOLDER) // $VALUE, $X
    .replace(/[ \t]+/g, WS_PLACEHOLDER); // collapse literal whitespace runs
  // Step 2: escape regex metacharacters in the literal portions. Parentheses
  // ARE escaped (they are literal syntax in the source code being scanned, not
  // regex groups). SCN-9: curly braces `{` `}` are ALSO escaped so a pattern
  // like `foo{2}` matches the literal string and isn't treated as a quantifier.
  translated = translated.replace(/[.*+?^$|[\]\\(){}]/g, '\\$&');
  // Step 3: replace the placeholders with their actual regex tokens.
  // The placeholders contain \u0000 which is not a regex metachar, so the
  // escape step left them alone.
  translated = translated.split(PLACEHOLDER).join('.*?');
  translated = translated.split(WS_PLACEHOLDER).join('\\s*');
  // SCN-7: if the pattern begins with a literal identifier, prepend `\b` so a
  // pattern like `eval($$$ARGS)` doesn't substring-match `medieval(x)`.
  const startsWithIdentifier = /^[A-Za-z_][A-Za-z0-9_]*/.test(pattern);
  if (startsWithIdentifier) {
    translated = '\\b' + translated;
    // W15-A5-7: a BARE-identifier pattern (letters/digits/underscore only —
    // e.g. the TODO/FIXME rules) also needs a TRAILING boundary, otherwise
    // `TODO` prefix-matches `TODOS` (same bug class metrics.js fixed with
    // `\bTODO\b`).
    if (/^[A-Za-z0-9_]+$/.test(pattern)) {
      translated = translated + '\\b';
    }
  }
  // ReDoS guard: a regex that begins with an unanchored `.*?` (e.g. the
  // sql-concat rule `$CONN.query("$$$" + $VAR)` → `.*?\.query(".*?" \+ .*?)`)
  // suffers catastrophic backtracking on long near-miss lines. Strip a leading
  // `.*?` — `RegExp.test()` already scans every start position, so the rest of
  // the pattern still matches anywhere in the line, just without the unbounded
  // backtracking wildcard prefix.
  if (translated.startsWith('.*?')) {
    translated = translated.slice(3);
  }
  try {
    return new RegExp(translated);
  } catch {
    return null;
  }
}

/**
 * File-extension → ast-grep language-name map (lowercased extensions).
 * js → js/mjs/cjs, ts → ts, jsx → jsx, tsx → tsx. Shared by the regex
 * fallback's language filter and the binary path's needed-language
 * computation.
 *
 * @type {Record<string, string>}
 */
const EXT_TO_LANG = {
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  ts: 'ts',
  jsx: 'jsx',
  tsx: 'tsx',
};

/**
 * Map a filename to its ast-grep language name via its extension, or `null`
 * when the extension is unknown/absent. Pure (no I/O).
 *
 * @param {string} filename
 * @returns {string | null}
 */
export function filenameToLanguage(filename) {
  if (typeof filename !== 'string') return null;
  const base = filename.split('/').pop() || filename;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  return EXT_TO_LANG[base.slice(dot + 1).toLowerCase()] || null;
}

/**
 * Determine whether a filename matches a rule's language set.
 *
 * - `'*'` in `languages` → matches anything
 * - otherwise, the file's extension (lowercased, no dot) must be in the
 *   language set (with the conventional mappings: js → js/mjs/cjs, ts → ts,
 *   jsx → jsx, tsx → tsx)
 *
 * @param {string} filename
 * @param {string[]} languages
 * @returns {boolean}
 */
export function fileMatchesLanguages(filename, languages) {
  if (!Array.isArray(languages) || languages.length === 0) return true;
  if (languages.includes('*')) return true;
  const lang = filenameToLanguage(filename);
  return lang ? languages.includes(lang) : false;
}

/**
 * Pure line-based pattern scanner. Walks the ADDED lines of each file's patch,
 * testing each rule's translated pattern against the line text. Returns
 * findings keyed to absolute (new-file) line numbers. NEVER throws.
 *
 * @param {Array<{filename?: string, patch?: string}>} files
 * @param {Array<object>} [rules] - rules to apply; defaults to DEFAULT_PATTERN_RULES.
 * @returns {Array<Record<string, unknown>>}
 */
export function scanPatternsRegex(files, rules = DEFAULT_PATTERN_RULES) {
  if (!Array.isArray(files)) return [];
  if (!Array.isArray(rules)) rules = DEFAULT_PATTERN_RULES;
  /** @type {Record<string, unknown>[]} */
  const out = [];
  for (const f of files || []) {
    if (!f || typeof f !== 'object') continue;
    const file = typeof f.filename === 'string' ? f.filename : '';
    if (!file) continue;
    const patch = typeof f.patch === 'string' ? f.patch : '';
    if (!patch) continue;

    // Pre-compile a regex per applicable rule (filter by language once per file).
    /** @type {Array<{rule: object, regex: RegExp}>} */
    const applicable = [];
    for (const rule of rules) {
      if (!rule || typeof rule !== 'object') continue;
      if (!fileMatchesLanguages(file, rule.languages)) continue;
      const regex = astGrepPatternToRegex(rule.pattern);
      if (!regex) continue;
      applicable.push({ rule, regex });
    }
    if (applicable.length === 0) continue;

    const addedLines = parseAddedLines(patch);
    for (const { line, text } of addedLines) {
      for (const { rule, regex } of applicable) {
        regex.lastIndex = 0;
        if (!regex.test(text)) continue;
        out.push({
          file,
          line,
          severity: rule.severity || 'medium',
          confidence: 'high',
          category: rule.category || 'maintainability',
          title: rule.title || rule.id || 'pattern',
          description:
            rule.description || `Pattern "${rule.pattern}" matched in the diff.`,
          evidence: text.trim(),
          suggestion: rule.suggestion ?? null,
          rule: `astgrep:${rule.id}`,
        });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * ast-grep integration
 * ------------------------------------------------------------------ */

/**
 * Spec for the ast-grep binary.
 *
 * IMPORTANT: ast-grep's release assets use the `app-*` prefix (not
 * `ast-grep-*`), and ALL platforms ship as `.zip` archives (each zip contains
 * a single `app-*` binary, optionally renamed to `ast-grep` on extraction).
 *
 * ast-grep does NOT publish a checksum file alongside its releases, so the
 * digests below were computed locally via `shasum -a 256` against the
 * downloaded zips. They MUST be re-verified and updated on every version bump.
 *
 * Extraction: every platform uses `zipExtractor` (the archive is always .zip).
 *
 * @type {Object}
 */
export const AST_GREP_SPEC = {
  name: 'ast-grep',
  version: '0.34.3',
  ext: '',
  // All ast-grep assets are .zip — used by the extractor dispatch in
  // `scanPatterns` (zipExtractor is hard-wired here for clarity).
  archiveType: 'zip',
  // The extracted binary filename inside each zip. ast-grep ships `app-*`
  // (not `ast-grep`) inside the archive, but we cache it under the spec name
  // `ast-grep` for consistency. zipExtractor handles the rename by passing
  // the destPath through; the bytes land at destPath regardless of the inner
  // entry name because bsdtar/GNU tar both unpack a single-member archive to
  // `-O` (stdout) when extracting into a dir + renaming is overkill. In
  // practice the scanner extracts to a temp dir then chmods destPath; see
  // zipExtractor for the rename logic.
  extractor: zipExtractor,
  urls: {
    darwin_arm64:
      'https://github.com/ast-grep/ast-grep/releases/download/0.34.3/app-aarch64-apple-darwin.zip',
    darwin_x64:
      'https://github.com/ast-grep/ast-grep/releases/download/0.34.3/app-x86_64-apple-darwin.zip',
    linux_arm64:
      'https://github.com/ast-grep/ast-grep/releases/download/0.34.3/app-aarch64-unknown-linux-gnu.zip',
    linux_x64:
      'https://github.com/ast-grep/ast-grep/releases/download/0.34.3/app-x86_64-unknown-linux-gnu.zip',
    win32_x64:
      'https://github.com/ast-grep/ast-grep/releases/download/0.34.3/app-x86_64-pc-windows-msvc.zip',
  },
  // REAL SHA256 digests, computed locally via `shasum -a 256` (no upstream
  // checksum file is published). Re-verify on every version bump.
  checksums: {
    darwin_arm64: 'eb0f2fb1b5f6e2210fe8bde4213264f855858adc793d48f14778b57e1f803749',
    darwin_x64: '4533770d6f9ca098ee4fd07c854d5862576b09c66cb24dba5c39a9a69e5a15f5',
    linux_arm64: 'cfaae1bf9d9e501471914b7e2c8253f4544ec75e017322079ca4a503f6787003',
    linux_x64: '9b58dfb710e98929beeebf7bb1efdf88751d6396275bf750cf79895835592715',
    win32_x64: '3b6f6797e54edda4b1b2a7dbaf9038c420a872f2f6f7415a7c52c6c6a5d094dc',
  },
};

/**
 * Normalize an ast-grep finding's `file` to the repo-RELATIVE, posix-separator
 * form used by GitHub filenames (W16-B3-1).
 *
 * Production runs `ast-grep ... <ABSOLUTE repoPath>` (repoPath is
 * process.cwd()), so the REAL binary emits ABSOLUTE paths in its JSON, while
 * the PR's changed-file names are repo-relative. If the path is absolute (or
 * sits under `source`), it is converted via path.relative(source, file) with
 * backslashes normalized to '/'; an already-relative path is returned
 * posix-normalized as-is.
 *
 * Pure (no I/O). Returns '' for bad input.
 *
 * @param {string} file
 * @param {string} source - the absolute repo path ast-grep was run against
 * @returns {string}
 */
export function normalizeFindingFilePath(file, source) {
  if (typeof file !== 'string' || file.length === 0) return '';
  const posixFile = file.replace(/\\/g, '/');
  const isAbsolute =
    nodePath.posix.isAbsolute(posixFile) ||
    /^[a-zA-Z]:/.test(posixFile) ||
    (typeof source === 'string' &&
      source.length > 0 &&
      (posixFile === source.replace(/\\/g, '/') ||
        posixFile.startsWith(
          (source.endsWith('/') ? source.slice(0, -1) : source).replace(/\\/g, '/') + '/',
        )));
  if (!isAbsolute) return posixFile;
  if (typeof source !== 'string' || source.length === 0) return posixFile;
  const rel = nodePath.relative(source, file);
  // W17-C1-5: `rel.startsWith('..')` also rejected legitimate IN-REPO paths
  // that merely START with '..' (e.g. '/repo/..hidden/x.js' → rel
  // '..hidden/x.js'), returning the unmatchable absolute path so the finding
  // was dropped by the changed-files filter. Only a true parent traversal —
  // '..' itself or a '../' (platform-separator) prefix — is outside source.
  if (!rel || rel === '..' || rel.startsWith('..' + nodePath.sep) || nodePath.isAbsolute(rel)) {
    return posixFile;
  }
  return rel.replace(/\\/g, '/');
}

/**
 * Map one ast-grep JSON match to our normalized finding schema.
 *
 * ast-grep `--json` emits an array of objects with at least:
 *   {
 *     "text": "eval('...')",     // the matched text
 *     "file": "src/foo.js",
 *     "lines": { "start": 42, "end": 42 },
 *     "column": { "start": 5, "end": 14 },
 *     "replacement": null,
 *     "matchedPattern": "...",    // present when --pattern, absent on --scan
 *     "ruleId": "eval",           // present when scanning with a rule YAML
 *   }
 *
 * W16-B3-2: the REAL ast-grep (0.34.3) emits `lines` as a STRING (the matched
 * text) and the 0-based start line under `range.start.line`. The line is read
 * from `range.start.line` (+1 → 1-based) first, falling back to the legacy
 * numeric `lines.start` shape used by older fixtures, and null when neither
 * exists.
 *
 * @param {object} match
 * @param {Map<string, object>} [ruleIndex] - ruleId → rule object (for title/desc lookup)
 * @returns {Record<string, unknown> | null}
 */
export function mapAstGrepFinding(match, ruleIndex) {
  if (!match || typeof match !== 'object') return null;
  const m = /** @type {Record<string, any>} */ (match);
  const file = typeof m.file === 'string' ? m.file : '';
  if (!file) return null;

  let startLine = null;
  const rangeStartLine =
    m.range &&
    typeof m.range === 'object' &&
    m.range.start &&
    typeof m.range.start === 'object' &&
    Number.isFinite(m.range.start.line)
      ? m.range.start.line
      : null;
  if (rangeStartLine !== null && rangeStartLine >= 0) {
    // Real ast-grep: range.start.line is 0-based.
    startLine = Math.floor(rangeStartLine) + 1;
  } else if (m.lines && Number.isFinite(m.lines.start) && m.lines.start >= 1) {
    // Legacy numeric shape (1-based in fixtures).
    startLine = Math.floor(m.lines.start);
  }
  const text = typeof m.text === 'string' ? m.text : '';
  const ruleId = typeof m.ruleId === 'string' && m.ruleId ? m.ruleId : 'match';
  const ruleObj = ruleIndex && ruleIndex.get(ruleId);
  const title = ruleObj?.title || `ast-grep rule "${ruleId}" matched`;
  const description =
    ruleObj?.description || `ast-grep rule "${ruleId}" matched in the diff.`;
  const suggestion = ruleObj?.suggestion ?? null;
  const severity = ruleObj?.severity || 'medium';
  const category = ruleObj?.category || 'maintainability';

  return {
    file,
    line: startLine,
    severity,
    confidence: 'high',
    category,
    title,
    description,
    evidence: text.trim(),
    suggestion,
    rule: `astgrep:${ruleId}`,
  };
}

/**
 * Parse the JSON output of `ast-grep scan --json` (or `run --json`) into an
 * array of normalized findings. Returns `[]` on any parse failure (never
 * throws). `ruleIndex` (ruleId → rule object) is used to enrich findings with
 * title/description/severity from the originating rule.
 *
 * @param {string} jsonText
 * @param {Map<string, object>} [ruleIndex]
 * @returns {Array<Record<string, unknown>>}
 */
export function parseAstGrepJson(jsonText, ruleIndex) {
  if (typeof jsonText !== 'string' || jsonText.trim().length === 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  /** @type {Record<string, unknown>[]} */
  const out = [];
  for (const element of parsed) {
    const mapped = mapAstGrepFinding(element, ruleIndex);
    if (mapped) out.push(mapped);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * scanPatterns — async orchestration
 * ------------------------------------------------------------------ */

/**
 * Scan for risky code patterns. Tries ast-grep first (via ensureBinary +
 * deps.runBinary); on ANY error warns via `deps.core.warning` and falls back
 * to `scanPatternsRegex(files, rules)`. NEVER throws.
 *
 * Binary path scoping (W15):
 *   - A5-1: ast-grep runs over the whole repo tree, so findings are filtered
 *     down to the PR's changed files (`opts.files` filenames).
 *   - A5-2: each rule runs once per language it declares that is ALSO needed
 *     by a changed file's extension (js/ts/jsx/tsx) — not just `languages[0]`.
 *   - A5-3: `*`-language rules (TODO/FIXME) cannot run via `ast-grep run`
 *     (it needs a concrete --lang); their diff-scoped regex findings are
 *     appended on the success path instead of being dropped.
 *   - Findings are deduped by `${file}:${line}:${rule}` before returning.
 *
 * @param {{ files: Array, repoPath: string, cacheDir?: string, rules?: Array }} opts
 * @param {{
 *   ensureBinary?: Function,
 *   runBinary?: Function,
 *   platform?: string,
 *   arch?: string,
 *   core?: { warning?: (msg: string) => void, info?: (msg: string) => void },
 * }} [deps]
 * @returns {Promise<{ findings: Array, scanner: 'ast-grep' | 'regex-fallback' }>}
 */
export async function scanPatterns(opts, deps = {}) {
  const files = Array.isArray(opts?.files) ? opts.files : [];
  const rules = Array.isArray(opts?.rules) ? opts.rules : DEFAULT_PATTERN_RULES;
  const core = deps.core;
  const platform = deps.platform || os.platform();
  const arch = deps.arch || os.arch();

  const regexFindings = scanPatternsRegex(files, rules);

  if (typeof deps.ensureBinary !== 'function' || typeof deps.runBinary !== 'function') {
    return { findings: regexFindings, scanner: 'regex-fallback' };
  }

  try {
    const asset = selectPlatformAsset(AST_GREP_SPEC, { platform, arch });
    if (!asset) {
      throw new Error(
        `ast-grep: no asset for platform=${platform || '?'} arch=${arch || '?'}`,
      );
    }
    const binaryPath = await deps.ensureBinary(
      { ...AST_GREP_SPEC, ...asset, cacheDir: opts.cacheDir },
      { platform, arch },
    );
    const source = opts.repoPath || process.cwd();

    // W15-A5-1: ast-grep runs over the WHOLE repo tree — scope reported
    // findings down to the PR's changed files.
    const changedFiles = changedFileNames(files);

    // W15-A5-2: compute the set of languages actually needed from the
    // extensions present in the changed files (js/mjs/cjs→js, ts→ts,
    // jsx→jsx, tsx→tsx). A rule then runs once per language it declares
    // that is needed — previously `rule.languages[0]` meant a js/ts/jsx/tsx
    // rule only ever ran as `js`, so .ts/.tsx files were never scanned.
    const neededLangs = new Set();
    for (const f of files) {
      const lang = filenameToLanguage(f && typeof f === 'object' ? f.filename : undefined);
      if (lang) neededLangs.add(lang);
    }

    // Run each rule via `ast-grep run --pattern <PATTERN> --json`. We do one
    // rule at a time to keep the JSON output shape simple (and to attribute
    // findings back to a specific rule via the ruleIndex lookup).
    /** @type {Record<string, unknown>[]} */
    const allFindings = [];
    const ruleIndex = new Map(rules.map((r) => [r.id, r]));
    // W15-A5-3: `*`-language rules (TODO/FIXME) — ast-grep `run` requires a
    // specific language, so they cannot go through the binary path. Collect
    // them here; their diff-scoped regex findings are APPENDED on success
    // (previously the success path returned only binary findings and the
    // TODO/FIXME rules silently vanished whenever ast-grep worked).
    /** @type {object[]} */
    const starRules = [];
    for (const rule of rules) {
      if (!rule || !rule.id || !rule.pattern) continue;
      const languages = Array.isArray(rule.languages) ? rule.languages : [];
      const runnableLanguages =
        languages.length > 0 && !languages.includes('*') ? languages : null;
      if (!runnableLanguages) {
        starRules.push(rule);
        continue;
      }
      for (const lang of runnableLanguages) {
        if (!neededLangs.has(lang)) continue;
        const args = [
          'run',
          '--pattern', rule.pattern,
          '--lang', lang,
          '--json',
          source,
        ];
        const result = await deps.runBinary(binaryPath, args, {
          cwd: source,
          maxBuffer: 10 * 1024 * 1024,
        });
        const stdout = typeof result === 'string' ? result : String(result?.stdout ?? '');
        // ast-grep's JSON doesn't include the ruleId on `run`, so attach it
        // manually before mapping.
        const enriched = parseAstGrepJson(stdout).map((f) => ({
          ...f,
          rule: `astgrep:${rule.id}`,
          title: rule.title || f.title,
          description: rule.description || f.description,
          severity: rule.severity || f.severity,
          category: rule.category || f.category,
          suggestion: rule.suggestion ?? f.suggestion,
        }));
        for (const f of enriched) allFindings.push(f);
      }
    }

    // W15-A5-3: keep `*`-rule (TODO/FIXME) findings from the diff-scoped
    // regex fallback on the binary success path.
    if (starRules.length > 0) {
      for (const f of scanPatternsRegex(files, starRules)) allFindings.push(f);
    }

    // W15-A5-1/A5-2: scope to changed files + dedup by file:line:rule.
    // W16-B3-1: the real binary emits ABSOLUTE paths (repoPath is
    // process.cwd()); normalize each finding's file to the repo-relative
    // posix form before matching it against the PR's GitHub filenames, and
    // rewrite the finding to carry the normalized name so downstream
    // inline-comment anchoring (which matches patch filenames) still works.
    const seen = new Set();
    /** @type {Record<string, unknown>[]} */
    const scoped = [];
    for (const f of allFindings) {
      const rawFile = typeof f.file === 'string' ? f.file : '';
      if (!rawFile) continue;
      const normalized = normalizeFindingFilePath(rawFile, source);
      if (!changedFiles.has(normalized) && !changedFiles.has(rawFile)) continue;
      f.file = normalized;
      const key = `${f.file}:${f.line}:${f.rule}`;
      if (seen.has(key)) continue;
      seen.add(key);
      scoped.push(f);
    }

    if (core?.info) {
      core.info(`ast-grep: ${scoped.length} pattern finding(s).`);
    }
    return { findings: scoped, scanner: 'ast-grep' };
  } catch (err) {
    if (core?.warning) {
      core.warning(
        `ast-grep unavailable, using regex fallback: ${err?.message ?? String(err)}`,
      );
    }
    return { findings: regexFindings, scanner: 'regex-fallback' };
  }
}
