/**
 * Load and validate a `.zai.yml` file from the PR's head SHA.
 *
 * The `.zai.yml` is the in-repo configuration file repos can commit to customize
 * review behavior WITHOUT editing their workflow YAML — the `.coderabbit.yaml`
 * pattern. Because it lives in the repository, it is ATTACKER-CONTROLLABLE in
 * fork PRs: a malicious contributor can commit a `.zai.yml` that tries to widen
 * the review's cost/security envelope. This module treats the file as
 * UNTRUSTED throughout:
 *
 *   - `parseZaiYml` is hand-rolled (no js-yaml dependency to attack surface),
 *     tolerant of malformed input, and never throws.
 *   - `validateRepoConfig` coerces types and DROPS every unknown key — only a
 *     fixed allow-list passes through.
 *   - `mergeRepoConfig` is the security-critical seam: action inputs ALWAYS win
 *     on cost/security knobs (`maxFindings`, `minSeverity`, the scanner master
 *     switch). The repo can only NARROW behavior (lower a cap, add path
 *     instructions, disable a scanner the action enabled).
 *   - `loadRepoConfig` wraps fetch + parse + validate in a single NEVER-throw
 *     boundary: any failure (404, parse error, validation drop, oversized) →
 *     `{}` + a `core.warning`.
 *
 * No `@actions/core` import; `core` is injected via `deps`.
 *
 * @module src/lib/repo-config.js
 */

/** Hard cap on the size of a `.zai.yml` we will parse (cost/DoS guard). */
const MAX_REPO_CONFIG_BYTES = 64 * 1024; // 64 KiB

/** Maximum length of `reviews.tone_instructions` after validation. */
const MAX_TONE_INSTRUCTIONS_CHARS = 500;
/** Maximum length of `reviews.language` after validation. */
const MAX_LANGUAGE_CHARS = 20;
/** Maximum length of a `path_instructions[].path` after validation. */
const MAX_PATH_INSTRUCTION_PATH_CHARS = 500;
/** Maximum length of a `path_instructions[].instructions` after validation. */
const MAX_PATH_INSTRUCTION_INSTRUCTIONS_CHARS = 1000;
/** Maximum number of `path_instructions` entries kept after validation. */
const MAX_PATH_INSTRUCTION_ENTRIES = 50;
/**
 * W5-4: Cap on the number of `path_filters` entries accepted from `.zai.yml`.
 * `path_filters` are UNION-ed into `excludePatterns` and tested via
 * `matchesAnyPattern` against every changed file, so a large list amplifies
 * per-file matching cost. The 64 KiB config budget allows thousands of short
 * entries, which a fork-PR attacker could use to slow the review into a DoS.
 * Mirrors the `MAX_PATH_INSTRUCTION_ENTRIES` guard on `path_instructions`.
 */
const MAX_PATH_FILTER_ENTRIES = 100;

/**
 * Strip a YAML `# ...` comment from a line, UNLESS the `#` is inside a
 * single- or double-quoted string. A `#` preceded by whitespace (or at the
 * start of the line) starts a comment; a `#` glued to a value (`url#anchor`)
 * does not — mirroring YAML 1.2. The quote-tracking is deliberately simple:
 * it toggles on the first quote char encountered and toggles back on the
 * matching one.
 *
 * @param {string} line
 * @returns {string}
 */
function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) {
      // W12-4b: the contraction guard (don't treat `'` as a delimiter when
      // preceded by alphanumeric, to handle `it's`) must NOT apply when we are
      // ALREADY inside a single-quoted string — a `'` inside a single-quoted
      // value is always the closing delimiter regardless of the preceding char.
      // Without this, `'see ref5'   # note` keeps inSingle=true after the
      // closing quote, so quotes aren't stripped and the comment leaks.
      if (inSingle) {
        inSingle = false;
      } else {
        const prev = i > 0 ? line[i - 1] : '';
        if (!/[A-Za-z0-9]/.test(prev)) {
          inSingle = !inSingle;
        }
      }
    } else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) {
      // A `#` only starts a comment when it's at the start of the line or
      // preceded by whitespace. `value#frag` is NOT a comment.
      const prev = i > 0 ? line[i - 1] : '';
      if (i === 0 || /\s/.test(prev)) {
        return line.slice(0, i);
      }
    }
  }
  return line;
}

/**
 * Unquote a YAML scalar value: strips matching surrounding single or double
 * quotes. Returns the input unchanged when not quoted.
 *
 * @param {string} v
 * @returns {string}
 */
function unquote(v) {
  if (typeof v !== 'string' || v.length < 2) return v;
  if (
    (v[0] === '"' && v[v.length - 1] === '"') ||
    (v[0] === "'" && v[v.length - 1] === "'")
  ) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Coerce a raw YAML scalar string into a JS value. Recognizes the literals
 * `true`/`false` (booleans) and integers; everything else stays a string.
 * Non-integer numbers stay strings (the schema has no float fields).
 *
 * @param {string} raw
 * @returns {boolean|number|string}
 */
function coerceScalar(raw) {
  const v = raw.trim();
  if (v === 'true' || v === 'True' || v === 'TRUE') return true;
  if (v === 'false' || v === 'False' || v === 'FALSE') return false;
  // Integer (optional leading sign, no decimal point).
  if (/^[+-]?\d+$/.test(v)) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return unquote(v).trim();
}

/** Known top-level keys. Anything else is dropped by the parser. */
const TOP_KEYS = new Set(['reviews', 'scanners']);
/** Known keys under `reviews:`. */
const REVIEW_KEYS = new Set([
  'profile',
  'max_findings',
  'path_instructions',
  'path_filters',
  'tone_instructions',
  'language',
]);
/** Known sub-fields of a `path_instructions` entry object. */
const PATH_INSTRUCTION_FIELDS = new Set(['path', 'instructions']);
/** Known keys under `scanners:`. */
const SCANNER_KEYS = new Set(['gitleaks', 'ast_grep', 'metrics']);

/**
 * Parse a minimal YAML subset into a plain object.
 *
 * Supports exactly the structure of `.zai.yml`:
 *   - top-level `reviews:` / `scanners:` maps
 *   - `key: value` scalars (quoted or unquoted, boolean/number/string)
 *   - arrays of strings (`- value`)
 *   - arrays of objects (`- key: value` on consecutive lines)
 *   - 2-space indentation
 *   - `#` comments (line and inline, quote-aware)
 *
 * Unknown keys at any level are SKIPPED (the validator double-checks, but
 * skipping in the parser keeps the output tidy). Malformed input never throws:
 * the offending line is skipped and parsing continues.
 *
 * Pure (exported for testing).
 *
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
export function parseZaiYml(text) {
  const out = {};
  if (typeof text !== 'string' || text.length === 0) return out;

  const lines = text.split(/\r?\n/);

  // Current top-level section key (`'reviews'` or `'scanners'`) or null.
  let section = null;
  // When inside `reviews.path_instructions` (an array of objects): the
  // in-progress object accumulator.
  let pendingObj = null;
  // When inside `reviews.path_filters` (an array of strings).
  let pendingArrayKey = null;

  const flushObj = () => {
    if (pendingObj !== null) {
      const arr = ensureArray(sectionObj(out, section), 'path_instructions');
      arr.push(pendingObj);
      pendingObj = null;
    }
  };
  const flushArray = () => {
    pendingArrayKey = null;
  };

  for (let raw of lines) {
    // Strip comments (quote-aware) then drop trailing whitespace.
    const lineNoComment = stripComment(raw);
    const line = lineNoComment.replace(/\s+$/, '');
    // Leading indentation count (spaces only — tabs are not valid YAML).
    const indent = line.length - line.replace(/^\s+/, '').length;
    const trimmed = line.trim();
    if (trimmed === '') continue;

    // Top-level key: `reviews:` or `scanners:` (indent 0).
    if (indent === 0) {
      // Flush any pending sub-structure before switching context.
      flushObj();
      flushArray();
      const m = trimmed.match(/^([A-Za-z0-9_]+):\s*$/);
      if (!m) continue; // unknown / malformed top-level line — skip
      const key = m[1];
      if (!TOP_KEYS.has(key)) continue; // unknown top-level key — skip
      section = key;
      if (!out[section]) out[section] = {};
      continue;
    }

    if (section === null) continue; // indented line with no open section — skip

    // Inside a section. Sub-keys are at indent >= 2.
    // Array item: a line beginning with `- `.
    if (/^-\s+/.test(trimmed) || trimmed === '-') {
      // We're in some array context.
      if (section === 'reviews') {
        // Flush any prior object/array before starting a new item.
        if (pendingArrayKey === 'path_filters') {
          // string array item: `- value`
          const val = trimmed.replace(/^-\s+/, '');
          if (val !== '' || trimmed !== '-') {
            const arr = ensureArray(out.reviews, 'path_filters');
            arr.push(coerceScalar(val));
          }
          continue;
        }
        if (pendingArrayKey === 'path_instructions' || pendingObj !== null) {
          // Object array item: `- key: value` (first line of a new object).
          flushObj();
          const body = trimmed.replace(/^-\s+/, '');
          const km = body.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
          if (km) {
            const k = km[1];
            const v = km[2];
            pendingObj = {};
            if (PATH_INSTRUCTION_FIELDS.has(k)) {
              pendingObj[k] = coerceScalar(v);
            }
            pendingArrayKey = 'path_instructions';
          } else {
            // `- value` form where the section was expecting objects — skip.
          }
          continue;
        }
        // First array item: detect which array by looking ahead is impossible
        // without a schema, so we infer from the key that OPENED the array.
        // (Handled when the array-key line was seen below.)
        continue;
      }
      continue; // arrays not supported under `scanners:` — skip
    }

    // Plain `key: value` line inside a section.
    const km = trimmed.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!km) continue;
    const key = km[1];
    const valRaw = km[2];

    if (section === 'reviews') {
      // Continuation of an array-of-objects entry: when we have a pending
      // object AND this key is a known sub-field of path_instructions
      // entries, append to the pending object rather than flushing it.
      if (
        pendingObj !== null &&
        (key === 'path' || key === 'instructions')
      ) {
        pendingObj[key] = coerceScalar(valRaw);
        continue;
      }
      if (!REVIEW_KEYS.has(key)) continue; // unknown review key — skip
      // Flush any pending object/array before a new top-level review key opens.
      if (key !== 'path_instructions' && key !== 'path_filters') {
        flushObj();
        flushArray();
      }
      if (valRaw === '') {
        // Block start: either path_instructions or path_filters.
        if (key === 'path_instructions' || key === 'path_filters') {
          flushObj();
          flushArray();
          pendingArrayKey = key;
          if (!Array.isArray(out.reviews[key])) out.reviews[key] = [];
        } else {
          // Empty value for a scalar key — skip (nothing to set).
        }
        continue;
      }
      // Scalar value.
      flushObj();
      flushArray();
      out.reviews[key] = coerceScalar(valRaw);
      continue;
    }

    if (section === 'scanners') {
      if (!SCANNER_KEYS.has(key)) continue; // unknown scanner key — skip
      if (valRaw === '') continue; // scanners have no nested values
      out.scanners[key] = coerceScalar(valRaw);
      continue;
    }
  }

  // Flush any trailing structure.
  flushObj();
  flushArray();

  return out;
}

/**
 * Get-or-create the section object `{}` on `out` for the given key.
 *
 * @param {Record<string, unknown>} out
 * @param {string} section
 * @returns {Record<string, unknown>}
 */
function sectionObj(out, section) {
  if (!out[section] || typeof out[section] !== 'object') out[section] = {};
  return out[section];
}

/**
 * Get-or-create an array on `obj` for the given key.
 *
 * @param {Record<string, unknown>} obj
 * @param {string} key
 * @returns {unknown[]}
 */
function ensureArray(obj, key) {
  if (!Array.isArray(obj[key])) obj[key] = [];
  return obj[key];
}

/* ------------------------------------------------------------------ *
 * validateRepoConfig
 * ------------------------------------------------------------------ */

/**
 * Validate a parsed `.zai.yml` object: coerce types, drop unknown keys, drop
 * invalid entries. Returns a NEW clean object; the input is not mutated.
 *
 * Returns `{}` for any non-object input and for empty input. Empty `reviews`
 * or `scanners` sub-objects are omitted from the output (no point carrying
 * empty containers).
 *
 * Pure (exported for testing).
 *
 * @param {unknown} parsed
 * @returns {{reviews?: Object, scanners?: Object}}
 */
export function validateRepoConfig(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const out = {};

  // ---- reviews ----
  const r = parsed.reviews;
  if (r && typeof r === 'object' && !Array.isArray(r)) {
    const rv = {};
    if (r.profile === 'chill' || r.profile === 'assertive') rv.profile = r.profile;
    if (Number.isInteger(r.max_findings) && r.max_findings > 0) {
      rv.max_findings = r.max_findings;
    }
    if (Array.isArray(r.path_instructions)) {
      const arr = r.path_instructions
        .map((entry) => normalizePathInstruction(entry))
        .filter((e) => e !== null)
        .slice(0, MAX_PATH_INSTRUCTION_ENTRIES);
      if (arr.length > 0) rv.path_instructions = arr;
    }
    if (Array.isArray(r.path_filters)) {
      const arr = r.path_filters
        .filter((p) => typeof p === 'string' && p.trim() !== '')
        .slice(0, MAX_PATH_FILTER_ENTRIES);
      if (arr.length > 0) rv.path_filters = arr;
    }
    if (typeof r.tone_instructions === 'string') {
      rv.tone_instructions =
        r.tone_instructions.length > MAX_TONE_INSTRUCTIONS_CHARS
          ? r.tone_instructions.slice(0, MAX_TONE_INSTRUCTIONS_CHARS)
          : r.tone_instructions;
    }
    if (typeof r.language === 'string') {
      rv.language =
        r.language.length > MAX_LANGUAGE_CHARS
          ? r.language.slice(0, MAX_LANGUAGE_CHARS)
          : r.language;
    }
    if (Object.keys(rv).length > 0) out.reviews = rv;
  }

  // ---- scanners ----
  const s = parsed.scanners;
  if (s && typeof s === 'object' && !Array.isArray(s)) {
    const sv = {};
    if (typeof s.gitleaks === 'boolean') sv.gitleaks = s.gitleaks;
    if (typeof s.ast_grep === 'boolean') sv.ast_grep = s.ast_grep;
    // W15-A1-2: metrics was missing from the boolean set, so the documented
    // `.zai.yml` `scanners.metrics: false` toggle was silently dropped.
    if (typeof s.metrics === 'boolean') sv.metrics = s.metrics;
    if (Object.keys(sv).length > 0) out.scanners = sv;
  }

  return out;
}

/**
 * Normalize one `path_instructions` entry to `{path, instructions}` or `null`.
 *
 * @param {unknown} entry
 * @returns {{path: string, instructions: string}|null}
 */
function normalizePathInstruction(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const path = entry.path;
  const instructions = entry.instructions;
  if (typeof path !== 'string' || path.trim() === '') return null;
  if (typeof instructions !== 'string' || instructions.trim() === '') return null;
  // Cap field lengths (truncate, mirroring tone_instructions/language handling)
  // so an attacker-controlled .zai.yml cannot bloat the prompt unboundedly.
  const cappedPath =
    path.length > MAX_PATH_INSTRUCTION_PATH_CHARS
      ? path.slice(0, MAX_PATH_INSTRUCTION_PATH_CHARS)
      : path;
  const cappedInstructions =
    instructions.length > MAX_PATH_INSTRUCTION_INSTRUCTIONS_CHARS
      ? instructions.slice(0, MAX_PATH_INSTRUCTION_INSTRUCTIONS_CHARS)
      : instructions;
  return { path: cappedPath, instructions: cappedInstructions };
}

/* ------------------------------------------------------------------ *
 * mergeRepoConfig
 * ------------------------------------------------------------------ */

/**
 * Merge a validated repo config into the action-input config.
 *
 * SECURITY-CRITICAL. The repo config is attacker-controllable, so action
 * inputs ALWAYS win on cost/security knobs; the repo can only NARROW behavior:
 *
 *   - `maxFindings`: `Math.min(action, repo)` — the repo can only LOWER the
 *     cap (never raise it).
 *   - `minSeverity`: action input wins (repo value is advisory-only in v1).
 *   - `pathInstructions` / `toneInstructions`: additive — the action has no
 *     equivalent knob, so these pass straight through from the repo.
 *   - `excludePatterns` (`pathFilters`): UNION — the repo can exclude MORE,
 *     never fewer.
 *   - `scanners`: the repo can DISABLE a scanner (`false`) but can never
 *     enable one the action's master switch turned off.
 *
 * The returned object is a flat config suitable for spreading into the
 * structured-review / scanner config shapes.
 *
 * Pure (exported for testing).
 *
 * @param {Object} actionConfig  the loadConfig() output (trusted).
 * @param {Object} repoConfig    the validated `.zai.yml` output (untrusted).
 * @returns {Object}
 */
export function mergeRepoConfig(actionConfig = {}, repoConfig = {}) {
  const a = actionConfig || {};
  const r = repoConfig && typeof repoConfig === 'object' ? repoConfig : {};
  const reviews = r.reviews && typeof r.reviews === 'object' ? r.reviews : {};
  const scanners = r.scanners && typeof r.scanners === 'object' ? r.scanners : {};

  // maxFindings: repo can only LOWER the cap.
  const actionMaxFindings =
    typeof a.maxFindings === 'number' && a.maxFindings > 0 ? a.maxFindings : 8;
  const repoMaxFindings =
    Number.isInteger(reviews.max_findings) && reviews.max_findings > 0
      ? reviews.max_findings
      : Number.POSITIVE_INFINITY;
  const maxFindings = Math.min(actionMaxFindings, repoMaxFindings);

  // pathInstructions: additive from repo only.
  const pathInstructions = Array.isArray(reviews.path_instructions)
    ? reviews.path_instructions
    : [];

  // toneInstructions: additive from repo only. The `reviews.language` field
  // (if set) is folded in here as a "Respond in <language>." directive so it
  // rides the existing additive tone path without a new prompt-builder seam.
  // This wires the previously-no-op `language` field to its documented effect.
  const toneParts = [];
  if (typeof reviews.tone_instructions === 'string' && reviews.tone_instructions.length > 0) {
    toneParts.push(reviews.tone_instructions);
  }
  if (typeof reviews.language === 'string' && reviews.language.trim().length > 0) {
    toneParts.push(`Respond in ${reviews.language.trim()}.`);
  }
  const toneInstructions = toneParts.join(' ');

  // excludePatterns UNION repo path_filters (repo can exclude MORE, never fewer).
  // A leading `!` in a path_filters entry is picomatch negation syntax, which
  // would invert the exclude-list semantics downstream in matchesAnyPattern.
  // The documented `.zai.yml` `!dist/**` form means "exclude dist/", so we
  // strip the leading `!` here to produce the positive `dist/**` form. This
  // is a defensive normalization: matchesAnyPattern ALSO strips `!`, but
  // doing it here keeps excludePatterns observable/correct at the merge
  // boundary. (CFG-1 / SCN-13.)
  const actionPatterns = Array.isArray(a.excludePatterns) ? a.excludePatterns : [];
  const repoFilters = Array.isArray(reviews.path_filters) ? reviews.path_filters : [];
  const stripNegation = (p) => (typeof p === 'string' && p.startsWith('!') ? p.slice(1) : p);
  const excludePatterns = Array.from(
    new Set([...actionPatterns, ...repoFilters.map(stripNegation)]),
  );

  // minSeverity: action input wins, BUT the repo `profile` may NARROW it.
  // `profile: chill` means "only surface critical+high" — i.e. raise the
  // effective floor to `high` (rank 1). The repo can only narrow (keep fewer
  // severities), never widen: if the action already set a stricter floor
  // (e.g. `high`), chill cannot lower it back to `medium`. `assertive` (the
  // default) leaves the action floor unchanged. This wires the previously-
  // no-op `profile` field to its documented effect.
  // Severity rank: lower = more severe (matches findings.js SEVERITY_RANK).
  const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const actionMinSeverity =
    typeof a.minSeverity === 'string' && SEVERITY_RANK[a.minSeverity] !== undefined
      ? a.minSeverity
      : 'info';
  let minSeverity = actionMinSeverity;
  const profile = typeof reviews.profile === 'string' ? reviews.profile : '';
  if (profile === 'chill') {
    // chill floor = high (rank 1). Narrow only: take the MORE restrictive
    // (lower-rank) of the action floor and chill's high floor.
    const actionRank = SEVERITY_RANK[actionMinSeverity];
    if (actionRank > SEVERITY_RANK.high) {
      minSeverity = 'high';
    }
  }
  // `assertive` (or unset) → action floor unchanged.

  // Scanners: master switch is action-only; repo can only DISABLE.
  const scannersEnabled = a.scannersEnabled !== false;
  const mergedScanners = scannersEnabled
    ? {
        // `false` in repo disables; otherwise the action default (enabled) applies.
        gitleaks: scanners.gitleaks !== false,
        ast_grep: scanners.ast_grep !== false,
        // W15-A1-2: metrics rides the same disable-only seam so src/index.js
        // can forward it to the scanner orchestrator (which already honors
        // repoScanners.metrics === false).
        metrics: scanners.metrics !== false,
      }
    : { gitleaks: false, ast_grep: false, metrics: false };

  return {
    ...a,
    maxFindings,
    minSeverity,
    pathInstructions,
    toneInstructions,
    excludePatterns,
    scannersEnabled,
    scanners: mergedScanners,
    // Surface profile/language on the merged config so callers/tests can
    // observe what was applied (the EFFECT is via minSeverity/toneInstructions
    // above; these fields are read-only observability).
    profile: profile || 'assertive',
    language: typeof reviews.language === 'string' ? reviews.language : '',
  };
}

/* ------------------------------------------------------------------ *
 * loadRepoConfig
 * ------------------------------------------------------------------ */

/**
 * Resolve the PR head SHA from `opts.headSha` or
 * `context.payload.pull_request.head.sha`.
 *
 * @param {Object} opts
 * @returns {string}
 */
function resolveHeadSha(opts) {
  if (typeof opts.headSha === 'string' && opts.headSha !== '') return opts.headSha;
  const sha = opts.context?.payload?.pull_request?.head?.sha;
  return typeof sha === 'string' ? sha : '';
}

/**
 * Load and validate `.zai.yml` from the PR's head SHA. Treated as UNTRUSTED.
 *
 * Flow:
 *   1. Resolve the head SHA (from `opts.headSha` or the PR payload).
 *   2. Fetch `.zai.yml` via `octokit.rest.repos.getContent({owner, repo, path, ref})`.
 *   3. Base64-decode the content.
 *   4. Parse with {@link parseZaiYml}.
 *   5. Validate with {@link validateRepoConfig}.
 *
 * On ANY error (404, parse failure, validation drop, oversized, missing SHA),
 * `deps.core.warning(...)` is called and `{}` is returned. This function
 * NEVER throws — a broken/untrusted `.zai.yml` must never break the review.
 *
 * @param {Object} opts - `{ octokit, context, path?, headSha? }`
 * @param {Object} [deps] - `{ core }` (for warnings).
 * @param {{warning?: Function, info?: Function}} [deps.core]
 * @returns {Promise<Object>}
 */
export async function loadRepoConfig(opts = {}, deps = {}) {
  const { octokit, context } = opts;
  const path = typeof opts.path === 'string' && opts.path !== '' ? opts.path : '.zai.yml';
  const core = deps.core;
  const warn = (msg) => {
    if (core && typeof core.warning === 'function') core.warning(msg);
  };

  const owner = context?.repo?.owner;
  const repo = context?.repo?.repo;
  if (!owner || !repo) {
    warn('repo-config: missing owner/repo in context; skipping .zai.yml load.');
    return {};
  }

  const headSha = resolveHeadSha(opts);
  if (headSha === '') {
    warn('repo-config: could not resolve PR head SHA; skipping .zai.yml load.');
    return {};
  }

  let data;
  try {
    const resp = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref: headSha,
    });
    data = resp?.data;
  } catch (error) {
    const status = error?.status;
    if (status === 404) {
      // 404 is the common case (most repos don't have a .zai.yml), but the
      // task brief specifies a warning on ANY error so callers can observe it.
      warn(`repo-config: no ${path} found at ${headSha.slice(0, 7)} (404).`);
      return {};
    }
    warn(
      `repo-config: failed to fetch ${path} (${status ?? 'unknown'}): ` +
        `${error?.message ?? String(error)}`,
    );
    return {};
  }

  // Decode the base64 content. GitHub returns `{content, encoding}` for files;
  // a directory or a non-file response is treated as "no config".
  let text;
  if (data && typeof data.content === 'string') {
    // Reject oversized content before decoding (cost/DoS guard).
    // `data.size` is the byte count GitHub reports; fall back to the
    // base64 length when missing.
    const size = typeof data.size === 'number' ? data.size : data.content.length;
    if (size > MAX_REPO_CONFIG_BYTES) {
      warn(
        `repo-config: ${path} is ${size} bytes (cap ${MAX_REPO_CONFIG_BYTES}); skipping.`,
      );
      return {};
    }
    try {
      text = Buffer.from(data.content.replace(/\s/g, ''), 'base64').toString('utf8');
    } catch {
      warn(`repo-config: ${path} could not be base64-decoded; skipping.`);
      return {};
    }
    // Post-decode size guard (base64 length can under-report).
    if (typeof text === 'string' && text.length > MAX_REPO_CONFIG_BYTES) {
      warn(
        `repo-config: ${path} decodes to ${text.length} chars (cap ${MAX_REPO_CONFIG_BYTES}); skipping.`,
      );
      return {};
    }
  } else if (typeof data === 'string') {
    text = data;
    if (text.length > MAX_REPO_CONFIG_BYTES) {
      warn(
        `repo-config: ${path} is ${text.length} chars (cap ${MAX_REPO_CONFIG_BYTES}); skipping.`,
      );
      return {};
    }
  } else {
    // Not a file (could be a directory listing or symlink) — no config.
    return {};
  }

  let parsed;
  try {
    parsed = parseZaiYml(text);
  } catch (error) {
    // parseZaiYml is never expected to throw, but defend in depth.
    warn(
      `repo-config: ${path} failed to parse: ${error?.message ?? String(error)}`,
    );
    return {};
  }

  // Treat a parse result with NO recognized keys as malformed/empty. The
  // parser is tolerant (garbage → `{}`), so we surface a warning here to make
  // a broken `.zai.yml` observable to operators while still returning `{}`.
  const validated = validateRepoConfig(parsed);
  if (Object.keys(validated).length === 0) {
    warn(
      `repo-config: ${path} parsed but contained no recognized keys; ignoring.`,
    );
    return {};
  }
  return validated;
}
