/**
 * Reads and validates GitHub Action inputs into a typed config object.
 *
 * In production these values come from `@actions/core`'s `core.getInput(name)`,
 * but for testability `loadConfig` accepts an `inputs` object (a Map or a plain
 * object of name→string) and an optional `core`-like dependency used only to
 * mask secrets. `@actions/core` is never imported at module load.
 *
 * Defaults are the fallback used when an input is empty/invalid — NOT the
 * action.yml defaults (those are applied by GitHub before the input reaches us).
 */

const TRUTHY = new Set(['true', '1', 'yes']);

function isTruthy(v) {
  return TRUTHY.has(String(v ?? '').trim().toLowerCase());
}

/**
 * Read a single input from either a Map or a plain object.
 * Always returns a string (possibly empty); never throws.
 */
function read(inputs, name) {
  let raw;
  if (inputs instanceof Map) {
    raw = inputs.has(name) ? inputs.get(name) : undefined;
  } else if (inputs && typeof inputs === 'object') {
    raw = inputs[name];
  }
  return raw === undefined || raw === null ? '' : String(raw);
}

export function toInt(v) {
  // CFG-8: parseInt alone happily accepts scientific notation ("1e5" → 1),
  // numeric separators ("1_000" → 1), and hex ("0x10" → 16), silently
  // truncating misconfigured inputs. Require the trimmed raw string to be a
  // pure optional-sign + digits integer; otherwise return null so callers
  // fall back to their default.
  const raw = typeof v === 'string' ? v.trim() : String(v ?? '').trim();
  if (!/^[+-]?\d+$/.test(raw)) return null;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * Parse a numeric input and clamp it to a positive minimum. Returns the
 * fallback when the parsed value is NaN, non-finite, or below `min`. This is
 * the defense against operator misconfiguration (e.g. ZAI_MAX_PATCH_CHARS=0)
 * that would otherwise break downstream invariants (infinite loops, degenerate
 * batching, etc.).
 *
 * @param {string} raw
 * @param {number} fallback
 * @param {number} [min=1] inclusive lower bound
 * @returns {number}
 */
function clampPositive(raw, fallback, min = 1) {
  const n = toInt(raw);
  if (n === null || !Number.isFinite(n) || n < min) return fallback;
  return n;
}

/**
 * Validate that `value` is one of the allowed `allowed` set; throw with the
 * given message otherwise.
 */
function validateEnum(value, allowed, message) {
  if (!allowed.has(value)) {
    throw new Error(message);
  }
  return value;
}

/**
 * Parse the ZAI_IMPACT_LABEL_MAP input (`critical=zai:critical,high=zai:high,...`)
 * into a {severity: label} object. Malformed entries are skipped silently.
 * @param {string} raw
 * @returns {{[severity: string]: string}}
 */
function parseImpactLabelMap(raw) {
  const def = {
    critical: 'zai:critical',
    high: 'zai:high',
    medium: 'zai:medium',
    low: 'zai:low',
  };
  if (typeof raw !== 'string' || raw.trim() === '') return def;
  const out = {};
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const sev = pair.slice(0, idx).trim().toLowerCase();
    const label = pair.slice(idx + 1).trim();
    if (sev && label) out[sev] = label;
  }
  // Merge over defaults so a partial map still covers all severities.
  return { ...def, ...out };
}

const AUTH_LEVELS = new Set(['admin', 'maintain', 'write', 'read', 'none']);
const AUTH_ERROR =
  'ZAI_AUTH_THRESHOLD must be one of: admin, maintain, write, read, none';

const SEVERITY_LEVELS = new Set(['critical', 'high', 'medium', 'low', 'info']);

/**
 * Parse and clamp a float input to the closed range [min, max]. Returns the
 * fallback when the value is NaN or non-finite. Used for `ZAI_TEMPERATURE`.
 *
 * @param {string} raw
 * @param {number} fallback
 * @param {number} min inclusive lower bound
 * @param {number} max inclusive upper bound
 * @returns {number}
 */
function clampFloat(raw, fallback, min, max) {
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/**
 * Parse and clamp a positive-integer input, then cap at `cap`. Returns the
 * fallback on NaN/non-finite/below-min. Used for `ZAI_MAX_FINDINGS` (cap 50)
 * and `ZAI_MAX_TOKENS` (no cap — pass Infinity).
 *
 * @param {string} raw
 * @param {number} fallback
 * @param {number} [cap=Infinity] inclusive upper bound
 * @returns {number}
 */
function clampPositiveCapped(raw, fallback, cap = Number.POSITIVE_INFINITY) {
  const n = toInt(raw);
  if (n === null || !Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, cap);
}

/**
 * Build the validated config object.
 *
 * @param {Map<string,string> | Record<string,string>} [inputs={}]
 * @param {{ core?: { setSecret: (s: string) => void } }} [options={}]
 * @returns {object}
 */
export function loadConfig(inputs = {}, options = {}) {
  const apiKey = read(inputs, 'ZAI_API_KEY').trim();
  if (apiKey === '') {
    throw new Error('ZAI_API_KEY is required');
  }

  const model = read(inputs, 'ZAI_MODEL').trim() || 'glm-5.2';
  const systemPrompt = read(inputs, 'ZAI_SYSTEM_PROMPT');
  const reviewerName = read(inputs, 'ZAI_REVIEWER_NAME').trim() || 'Z.ai Code Review';

  const excludeRaw = read(inputs, 'EXCLUDE_PATTERNS');
  const excludePatterns =
    excludeRaw.trim() === ''
      ? ['*.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']
      : excludeRaw
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p !== '');

  // maxDiffChars: parseInt base 10, NaN -> default. 0 (and any negative) means
  // "unlimited" — documented in action.yml and honored here. The DEFAULT is a
  // sane cap; operators who want unlimited set MAX_DIFF_CHARS=0 (or a negative)
  // explicitly. A positive integer is honored as the per-batch char cap.
  const maxDiffCharsRaw = toInt(read(inputs, 'MAX_DIFF_CHARS'));
  const maxDiffChars =
    maxDiffCharsRaw === null
      ? 100000
      : maxDiffCharsRaw <= 0
        ? 0
        : maxDiffCharsRaw;

  // Numeric knobs that drive loops/batching must be positive; clamp to a safe
  // default on any non-finite/negative/zero value to prevent infinite loops
  // (splitTextByLines) and degenerate one-entry-per-batch cost blow-ups.
  const largePrFileThreshold = clampPositive(
    read(inputs, 'ZAI_LARGE_PR_FILE_THRESHOLD'), 50,
  );
  // W18-D3-4: floor at 1000 chars. A min of 1 accepted e.g.
  // ZAI_MAX_BATCH_CHARS=1 → a degenerate one-batch-per-entry split (30 files
  // → 30 API calls), contradicting the clamp's stated purpose of preventing
  // degenerate batching. Below-floor values fall back to the default, the
  // same below-min→default semantics clampPositive applies to ZAI_TIMEOUT_MS.
  const maxBatchChars = clampPositive(
    read(inputs, 'ZAI_MAX_BATCH_CHARS'), 120000, 1000,
  );
  const maxFilesPerBatch = clampPositive(read(inputs, 'ZAI_MAX_FILES_PER_BATCH'), 40);
  const maxPatchChars = clampPositive(read(inputs, 'ZAI_MAX_PATCH_CHARS'), 18000);
  const timeoutMs = clampPositive(read(inputs, 'ZAI_TIMEOUT_MS'), 120000, 1000);

  const commandsEnabled = isTruthy(read(inputs, 'ZAI_COMMANDS_ENABLED'));
  const allowForkCommands = isTruthy(read(inputs, 'ZAI_ALLOW_FORK_COMMANDS'));

  const authThreshold =
    read(inputs, 'ZAI_AUTH_THRESHOLD').trim() || 'write';
  validateEnum(authThreshold, AUTH_LEVELS, AUTH_ERROR);

  // Schedule feature (opt-in, off by default).
  const scheduleEnabled = isTruthy(read(inputs, 'ZAI_SCHEDULE_ENABLED'));
  // scheduleMaxPrs: capped at an absolute maximum (100) so a runaway value
  // cannot trigger unbounded sequential work on a schedule tick. The default
  // remains 10; values up to 100 pass through; above 100 is clamped to 100.
  const scheduleMaxPrs = clampPositiveCapped(read(inputs, 'ZAI_SCHEDULE_MAX_PRS'), 10, 100);

  // describe/impact opt-in mutation features (off by default — v1 stays
  // read-only unless the operator explicitly enables them).
  const describeWriteBody = isTruthy(read(inputs, 'ZAI_DESCRIBE_WRITE_BODY'));
  const impactLabels = isTruthy(read(inputs, 'ZAI_IMPACT_LABELS'));
  const impactLabelMap = parseImpactLabelMap(read(inputs, 'ZAI_IMPACT_LABEL_MAP'));

  // v2 structured-review knobs.
  const maxFindings = clampPositiveCapped(
    read(inputs, 'ZAI_MAX_FINDINGS'),
    8,
    50,
  );

  // minSeverity: validate against the allowed set; invalid → 'info' + warning.
  const minSeverityRaw = read(inputs, 'ZAI_MIN_SEVERITY').trim().toLowerCase();
  let minSeverity = 'info';
  if (minSeverityRaw !== '') {
    if (SEVERITY_LEVELS.has(minSeverityRaw)) {
      minSeverity = minSeverityRaw;
    } else {
      minSeverity = 'info';
      if (options?.core?.warning) {
        options.core.warning(
          `ZAI_MIN_SEVERITY "${minSeverityRaw}" is invalid; falling back to "info". ` +
            `Allowed: critical, high, medium, low, info.`,
        );
      }
    }
  }

  const temperature = clampFloat(read(inputs, 'ZAI_TEMPERATURE'), 0.2, 0, 2);
  const maxTokens = clampPositiveCapped(read(inputs, 'ZAI_MAX_TOKENS'), 4096);

  // Phase 6.1: bounded batch concurrency. Default 3, clamped to [1, 8].
  // Below-1 values are treated as invalid (defensive: a future caller cannot
  // request serial/zero concurrency and stall the pipeline). 8 is the cap so
  // an over-eager operator cannot DOS the provider.
  const batchConcurrencyRaw = toInt(read(inputs, 'ZAI_BATCH_CONCURRENCY'));
  let batchConcurrency = 3;
  if (batchConcurrencyRaw !== null && Number.isFinite(batchConcurrencyRaw) && batchConcurrencyRaw >= 1) {
    batchConcurrency = Math.min(batchConcurrencyRaw, 8);
  }

  // Phase 6.2: optional fallback prompt that activates the callWithRetry
  // timeout-fallback mechanism. Empty (default) = disabled; a non-empty
  // trimmed string is forwarded to the API client.
  const fallbackPromptRaw = read(inputs, 'ZAI_FALLBACK_PROMPT').trim();
  const fallbackPrompt = fallbackPromptRaw === '' ? '' : fallbackPromptRaw;

  // v2 deterministic-scanner knobs (Phase 4). The master switch defaults to
  // TRUE — the action.yml input also defaults to 'true', but loadConfig
  // applies the same default so direct callers (e.g. tests, programmatic
  // users) get the same behavior. The master switch is an action input (only
  // the action can turn scanning ON); per-scanner DISABLE toggles live in
  // repo-level .zai.yml (Phase 3) and can only turn a scanner OFF.
  const scannersEnabledRaw = read(inputs, 'ZAI_SCANNERS_ENABLED').trim().toLowerCase();
  const scannersEnabled =
    scannersEnabledRaw === '' ? true : isTruthy(scannersEnabledRaw);
  const scannersCacheDir =
    read(inputs, 'ZAI_SCANNERS_CACHE_DIR').trim() || '~/.zai-cache/scanners';

  const githubToken = read(inputs, 'GITHUB_TOKEN');

  // Phase 5: commit-status feedback (pending → success/failure). Defaults to
  // TRUE — posting a commit status gives developers immediate feedback while
  // the review runs, matching CodeRabbit's commit_status feature. Requires the
  // workflow's `permissions:` block to grant `statuses: write`. The master
  // switch follows the same empty=default convention as scannersEnabled: an
  // empty input means "use the default" (true), so direct callers (tests,
  // programmatic users) get the feature without setting the input.
  const commitStatusRaw = read(inputs, 'ZAI_COMMIT_STATUS').trim().toLowerCase();
  const commitStatus =
    commitStatusRaw === '' ? true : isTruthy(commitStatusRaw);

  // Phase 7: walkthrough / cohort-ordered summary rendering. When true
  // (default), the summary findings are reorganized into dependency-ordered
  // collapsible cohort sections (database → api → business-logic → … → other)
  // instead of a flat severity-sorted list. Inline comments stay line-anchored
  // and are unaffected; only the SUMMARY rendering changes. Empty input means
  // "use the default" (true), matching the scannersEnabled/commitStatus
  // convention so direct callers get the feature without setting the input.
  const walkthroughRaw = read(inputs, 'ZAI_WALKTHROUGH').trim().toLowerCase();
  const walkthrough =
    walkthroughRaw === '' ? true : isTruthy(walkthroughRaw);

  // Phase 6.3: incremental review. When true (default), the PR review path
  // stores a content hash of every finding inside a hidden HTML comment in the
  // review body. On re-push, the bot parses that block out of the prior
  // review and suppresses findings whose hash is unchanged — CodeRabbit's
  // `auto_incremental_review` pattern — so only NEW or CHANGED findings
  // surface. Empty input means "use the default" (true), matching the
  // scannersEnabled/commitStatus/walkthrough convention so direct callers get
  // the feature without setting the input.
  const incrementalReviewRaw = read(inputs, 'ZAI_INCREMENTAL_REVIEW').trim().toLowerCase();
  const incrementalReview =
    incrementalReviewRaw === '' ? true : isTruthy(incrementalReviewRaw);

  // Phase 3: in-repo config file (`.zai.yml`). The master switch defaults to
  // TRUE — repos can commit a `.zai.yml` to tailor review behavior (path
  // instructions, tone) WITHOUT editing their workflow YAML. The file is
  // fetched from the PR head SHA and treated as UNTRUSTED (attacker-
  // controllable in fork PRs): mergeRepoConfig enforces that it can only
  // NARROW behavior (lower a cap, add excludes, disable a scanner), never
  // widen it. Operators who don't want repo-config loading at all can set
  // ZAI_REPO_CONFIG_ENABLED=false.
  const repoConfigEnabledRaw = read(inputs, 'ZAI_REPO_CONFIG_ENABLED').trim().toLowerCase();
  const repoConfigEnabled =
    repoConfigEnabledRaw === '' ? true : isTruthy(repoConfigEnabledRaw);

  // Phase 8.3: strict review mode. When true, the PR auto-review is submitted
  // with event=REQUEST_CHANGES (instead of COMMENT) whenever there are
  // critical/high findings — which BLOCKS merge until the review is dismissed
  // or the changes addressed. Aggressive: OFF by default and NEVER
  // auto-enabled. Only fires when explicitly turned on AND a critical/high
  // finding exists (resolveReviewEvent enforces both conditions). Requires
  // `pull-requests: write` (already needed to post reviews).
  const strictMode = isTruthy(read(inputs, 'ZAI_STRICT_MODE'));

  // Phase 8.1: CODEOWNERS-aware reviewer suggestions. Read-only by default —
  // when `ZAI_SUGGEST_REVIEWERS=true`, the bot parses the PR's CODEOWNERS,
  // computes the owners of the changed paths, and appends a "Suggested
  // reviewers" line to the review summary (no PR mutation). When
  // `ZAI_AUTO_ASSIGN_REVIEWERS=true` (implies suggest), the bot additionally
  // calls `pulls.requestReviewers` with the user handles. Both are OFF by
  // default — matching the v1 read-only convention. The CODEOWNERS file is
  // fetched from the head SHA and treated as UNTRUSTED (attacker-controllable
  // in fork PRs); only `@user` handles (no `@org/team`) are forwarded to
  // requestReviewers (teams require extra perms and are summary-only).
  const suggestReviewers = isTruthy(read(inputs, 'ZAI_SUGGEST_REVIEWERS'));
  const autoAssignReviewers = isTruthy(read(inputs, 'ZAI_AUTO_ASSIGN_REVIEWERS'));

  // Phase 8.2: learnings / memory (`.zai/learnings.yml`). The master switch
  // defaults to FALSE — opt-in — because the learnings file is a NEW trust
  // surface (attacker-controllable in fork PRs): a malicious contributor could
  // commit a learnings entry that suppresses a real security finding. When
  // enabled, the bot fetches `.zai/learnings.yml` from the PR head SHA, treats
  // it as UNTRUSTED, and suppresses findings whose (file, title/description)
  // clearly match a recorded "previously-reviewed / won't-fix" pattern. The
  // suppression is conservative (glob + case-insensitive substring on BOTH
  // axes); the prompt also carries the accepted patterns as additive context.
  const learningsEnabled = isTruthy(read(inputs, 'ZAI_LEARNINGS_ENABLED'));

  const config = {
    apiKey,
    model,
    systemPrompt,
    reviewerName,
    excludePatterns,
    maxDiffChars,
    largePrFileThreshold,
    maxBatchChars,
    maxFilesPerBatch,
    maxPatchChars,
    commandsEnabled,
    authThreshold,
    allowForkCommands,
    timeoutMs,
    scheduleEnabled,
    scheduleMaxPrs,
    describeWriteBody,
    impactLabels,
    impactLabelMap,
    maxFindings,
    minSeverity,
    temperature,
    maxTokens,
    batchConcurrency,
    fallbackPrompt,
    scannersEnabled,
    scannersCacheDir,
    commitStatus,
    walkthrough,
    incrementalReview,
    repoConfigEnabled,
    strictMode,
    suggestReviewers,
    autoAssignReviewers,
    learningsEnabled,
    githubToken,
  };

  // Mask secrets if a core-like dependency was provided.
  const core = options?.core;
  if (core && typeof core.setSecret === 'function') {
    core.setSecret(config.apiKey);
    core.setSecret(config.githubToken);
  }

  return config;
}
