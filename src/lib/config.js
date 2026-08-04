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

function toInt(v) {
  const n = parseInt(v, 10);
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

  // maxDiffChars: parseInt base 10, NaN -> default. 0 means "unlimited"
  // (documented); negatives are treated as 0 (unlimited) for safety. The
  // DEFAULT is a sane cap (set in action.yml); operators who want unlimited
  // set MAX_DIFF_CHARS=0 explicitly.
  const maxDiffCharsRaw = toInt(read(inputs, 'MAX_DIFF_CHARS'));
  const maxDiffChars =
    maxDiffCharsRaw === null || maxDiffCharsRaw < 0 ? 100000 : maxDiffCharsRaw;

  // Numeric knobs that drive loops/batching must be positive; clamp to a safe
  // default on any non-finite/negative/zero value to prevent infinite loops
  // (splitTextByLines) and degenerate one-entry-per-batch cost blow-ups.
  const largePrFileThreshold = clampPositive(
    read(inputs, 'ZAI_LARGE_PR_FILE_THRESHOLD'), 50,
  );
  const maxBatchChars = clampPositive(read(inputs, 'ZAI_MAX_BATCH_CHARS'), 120000);
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
  const scheduleMaxPrs = clampPositive(read(inputs, 'ZAI_SCHEDULE_MAX_PRS'), 10);

  // describe/impact opt-in mutation features (off by default — v1 stays
  // read-only unless the operator explicitly enables them).
  const describeWriteBody = isTruthy(read(inputs, 'ZAI_DESCRIBE_WRITE_BODY'));
  const impactLabels = isTruthy(read(inputs, 'ZAI_IMPACT_LABELS'));
  const impactLabelMap = parseImpactLabelMap(read(inputs, 'ZAI_IMPACT_LABEL_MAP'));

  const githubToken = read(inputs, 'GITHUB_TOKEN');

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
