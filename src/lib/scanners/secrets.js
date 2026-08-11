/**
 * Secret detection: gitleaks (preferred) + a hand-rolled regex fallback.
 *
 * Architecture — the injection seam:
 *   - `deps.runBinary(args, opts)` shells out to the real gitleaks binary in
 *     production; tests inject a fake that returns canned JSON.
 *   - `deps.ensureBinary(spec, deps)` fetches+verifies+cache the gitleaks
 *     binary in production; tests inject a fake that returns a fake path.
 *   - On ANY error (binary unavailable, exec failure, parse failure), the
 *     scanner falls back to `scanSecretsRegex(files)` (pure, no I/O) and
 *     warns via `deps.core.warning`.
 *
 * The regex fallback is exported for direct testing — it's the high-value
 * pure logic, fully unit-testable without any binaries.
 *
 * @module src/lib/scanners/secrets.js
 */

import os from 'node:os';
import { parseAddedLines } from './_patch.js';
import { selectPlatformAsset, pickExtractor } from './ensure-binary.js';

/* ------------------------------------------------------------------ *
 * Shannon entropy helper (used to suppress low-entropy false positives)
 * ------------------------------------------------------------------ */

/**
 * Compute Shannon entropy (base-2) of a string. Higher = more random.
 *
 * @param {string} s
 * @returns {number}
 */
export function shannonEntropy(s) {
  if (typeof s !== 'string' || s.length === 0) return 0;
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  const len = s.length;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/* ------------------------------------------------------------------ *
 * Regex fallback
 * ------------------------------------------------------------------ */

/**
 * The hand-rolled secret patterns. Each entry: `{ name, regex, severity?, confidence?,
 * category?, title?, description?, suggestion?, captureGroup?, minEntropy? }`.
 *
 * The `value` mapped into the finding's `evidence` is the matched substring by
 * default, or the capture group at index `captureGroup` if set. When
 * `minEntropy` is set, the value's Shannon entropy must be ≥ that threshold or
 * the match is dropped (false-positive suppression).
 *
 * @type {Array<Object>}
 */
export const SECRET_PATTERNS = [
  {
    name: 'aws-access-key-id',
    regex: /\bAKIA[0-9A-Z]{16}\b/,
    title: 'AWS access key ID detected',
    description: 'An AWS access key ID (AKIA...) was found in the diff.',
    suggestion: 'Remove the key and rotate it in the AWS console immediately.',
  },
  {
    name: 'github-pat',
    // SCN-1: also match fine-grained PATs `github_pat_<82 chars>` (the default
    // since Oct 2022). Classic PATs are gh[pousr]_ + 36-255 alphanumerics.
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{82,})\b/,
    title: 'GitHub personal access token detected',
    description: 'A GitHub PAT (ghp_/gho_/ghu_/ghs_/ghr_/github_pat_) was found in the diff.',
    suggestion: 'Remove the token and revoke it at github.com/settings/tokens.',
  },
  {
    // W11-3: the regex used to require the literal suffix `PRIVATE KEY-----`
    // immediately after an optional type prefix, which missed two common PEM
    // headers: `-----BEGIN ENCRYPTED PRIVATE KEY-----` (PKCS#8 encrypted keys,
    // where "ENCRYPTED " was absent from the type alternation) and
    // `-----BEGIN PGP PRIVATE KEY BLOCK-----` (GnuPG keys, where the trailing
    // ` BLOCK` broke the `PRIVATE KEY-----` suffix). The pattern now accepts
    // any optional uppercase prefix before `PRIVATE KEY` and an optional
    // ` BLOCK` suffix, covering every PEM private-key header in the wild.
    name: 'private-key-block',
    regex: /-----BEGIN (?:[A-Z ]*)PRIVATE KEY(?: BLOCK)?-----/,
    title: 'Private key block detected',
    description: 'A PEM-encoded private key block was found in the diff.',
    suggestion: 'Remove the key and rotate any credentials it protected.',
  },
  {
    name: 'slack-token',
    regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/,
    title: 'Slack token detected',
    description: 'A Slack token (xox[baprs]-...) was found in the diff.',
    suggestion: 'Remove the token and revoke it at api.slack.com/...',
  },
  {
    name: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    title: 'JWT detected',
    description: 'A JSON Web Token was found in the diff. JWTs may carry secrets.',
    suggestion: 'Avoid embedding JWTs in source; load from a secret manager.',
  },
  {
    name: 'db-connection-string',
    regex: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s'"`<>:]+:[^\s'"`<>@]+@[^\s'"`<>]+/i,
    title: 'Database connection string with credentials',
    description: 'A DB connection string with an embedded password was found.',
    suggestion: 'Use environment variables / a secret manager for DB credentials.',
  },
  {
    name: 'generic-assignment',
    // Match: api_key/apikey/api-key/secret/password/passwd/token/auth followed
    // by an assignment and a quoted value of length >= 8. Capture group 1 is
    // the value, on which we run an entropy check (≥ 3.5 Shannon) to suppress
    // false positives like `password = "password"`.
    regex: /\b(?:api[_-]?key|apikey|secret|password|passwd|token|auth[_-]?token|access[_-]?token|client[_-]?secret)\b['"\s:=+]{1,5}['"]([0-9a-zA-Z!@#$%^&*_+\-.]{8,})['"]/i,
    captureGroup: 1,
    minEntropy: 3.5,
    title: 'Hardcoded credential assigned to a key',
    description: 'A value assigned to a credential-like key looks like a secret.',
    suggestion: 'Load credentials from environment variables or a secret manager.',
  },
  {
    name: 'high-entropy-string',
    // A base64-ish token ≥ 32 chars with Shannon entropy ≥ 4.5 — very
    // conservative, only flags obvious secrets. The regex captures the candidate
    // (alphanumeric + /+=); the entropy check filters out non-secret strings.
    // SCN-2: include `-` and `_` so URL-safe base64 secrets are matched.
    regex: /\b([A-Za-z0-9+/\-_]{32,}={0,2})\b/,
    captureGroup: 1,
    minEntropy: 4.5,
    title: 'High-entropy string (possible secret)',
    description:
      'A long, high-entropy string was found in the diff. This often indicates an ' +
      'embedded API key, token, or other secret.',
    suggestion:
      'Confirm whether this value is a secret. If so, remove it and rotate; otherwise ignore.',
  },
];

/**
 * Map a regex match to a finding object. Centralizes the finding shape so both
 * the regex fallback and the high-entropy heuristic produce consistent output.
 *
 * @param {{ file: string, line: number, value: string, pattern: object }} args
 * @returns {Record<string, unknown>}
 */
function buildFinding({ file, line, value, pattern }) {
  return {
    file,
    line,
    severity: pattern.severity || 'critical',
    confidence: pattern.confidence || 'high',
    category: pattern.category || 'security',
    title: pattern.title,
    description: pattern.description,
    evidence: value,
    suggestion: pattern.suggestion ?? null,
    rule: `regex:${pattern.name}`,
  };
}

/**
 * Mask a secret value for the `evidence` field, keeping the first 4 and last 2
 * chars visible and replacing the middle with `…`. Short values (≤ 12 chars)
 * are masked entirely (first char + `…`) to avoid over-revealing. Used so the
 * evidence field doesn't re-leak the full secret in the review comment.
 *
 * SCN-6: threshold raised from 8 to 12 — for 9-12 char secrets, first4+last2
 * exposes 6 of 9-12 chars, which is too much. Mask to first char only.
 *
 * @param {string} value
 * @returns {string}
 */
export function maskSecret(value) {
  if (typeof value !== 'string') return '';
  if (value.length <= 12) return value.length > 0 ? `${value[0]}…` : '';
  return `${value.slice(0, 4)}…${value.slice(-2)}`;
}

/**
 * Pure regex-based secret scanner. Walks the ADDED lines of each file's patch
 * and tests each SECRET_PATTERN against the line text. Returns findings keyed
 * to absolute (new-file) line numbers. NEVER throws.
 *
 * @param {Array<{filename?: string, patch?: string}>} files
 * @returns {Array<Record<string, unknown>>}
 */
export function scanSecretsRegex(files) {
  if (!Array.isArray(files)) return [];
  /** @type {Record<string, unknown>[]} */
  const out = [];
  for (const f of files || []) {
    if (!f || typeof f !== 'object') continue;
    const file = typeof f.filename === 'string' ? f.filename : '';
    if (!file) continue;
    const patch = typeof f.patch === 'string' ? f.patch : '';
    if (!patch) continue;

    const addedLines = parseAddedLines(patch);
    for (const { line, text } of addedLines) {
      for (const pattern of SECRET_PATTERNS) {
        pattern.regex.lastIndex = 0; // defense in depth for stateful regexes
        const match = pattern.regex.exec(text);
        if (!match) continue;

        // Resolve the value used for evidence + entropy check.
        const groupIdx = typeof pattern.captureGroup === 'number' ? pattern.captureGroup : 0;
        const value = match[groupIdx] || match[0];

        if (typeof pattern.minEntropy === 'number') {
          const ent = shannonEntropy(value);
          if (ent < pattern.minEntropy) continue;
        }

        out.push(
          buildFinding({
            file,
            line,
            // Mask the secret in evidence so we don't re-leak it in the comment.
            value: maskSecret(value),
            pattern,
          }),
        );
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Gitleaks integration
 * ------------------------------------------------------------------ */

/**
 * Spec for the gitleaks binary. URLs and SHA256 checksums are REAL — verified
 * against `gitleaks_8.21.2_checksums.txt` from the v8.21.2 GitHub release.
 *
 * gitleaks ships as a .tar.gz on macOS/Linux and a .zip on Windows. The
 * extractor is selected per-asset via `pickExtractor(url)` (see
 * `scanSecrets`); the dispatch handles both archive types with one spec.
 *
 * @type {Object}
 */
export const GITLEAKS_SPEC = {
  name: 'gitleaks',
  version: '8.21.2',
  ext: '', // the extracted binary has no extension
  urls: {
    darwin_arm64:
      'https://github.com/gitleaks/gitleaks/releases/download/v8.21.2/gitleaks_8.21.2_darwin_arm64.tar.gz',
    darwin_x64:
      'https://github.com/gitleaks/gitleaks/releases/download/v8.21.2/gitleaks_8.21.2_darwin_x64.tar.gz',
    linux_arm64:
      'https://github.com/gitleaks/gitleaks/releases/download/v8.21.2/gitleaks_8.21.2_linux_arm64.tar.gz',
    linux_x64:
      'https://github.com/gitleaks/gitleaks/releases/download/v8.21.2/gitleaks_8.21.2_linux_x64.tar.gz',
    win32_x64:
      'https://github.com/gitleaks/gitleaks/releases/download/v8.21.2/gitleaks_8.21.2_windows_x64.zip',
  },
  // REAL SHA256 digests from gitleaks_8.21.2_checksums.txt (v8.21.2 release).
  checksums: {
    darwin_arm64: 'cad3de5dc9a4d5447d967a70a4d49499c557f04db028274cc324f9ff983f6502',
    darwin_x64: '5b42c6e4b1fd693eaeb2b5b7faa5f17a1434299d4deb2de63d4b2efd7c753128',
    linux_arm64: '654c935542c89f565aabe7bf7c6c500830f116c114f0aeb509d2460c1ac2e6da',
    linux_x64: '5bc41815076e6ed6ef8fbecc9d9b75bcae31f39029ceb55da08086315316e3ba',
    win32_x64: 'f238c85e5f47e18fac779ce71ee11091cf70a0a8fb4415f165efba2800eef133',
  },
};

/**
 * Map a parsed gitleaks finding (one element of the `findings` array in the
 * gitleaks JSON report) to our normalized finding schema.
 *
 * Gitleaks finding shape (v8.x):
 *   {
 *     "RuleID": "aws-access-token",
 *     "Description": "...",
 *     "Match": "AKIA...",          // the matched secret value (FULL — mask it!)
 *     "Secret": "AKIA...",
 *     "File": "src/foo.js",
 *     "StartLine": 42,
 *     "EndLine": 42,
 *     "StartColumn": 7,
 *     "EndColumn": 27,
 *     "Fingerprint": "src/foo.js:aws-access-token:42",
 *     "Entropy": 3.78
 *   }
 *
 * @param {object} gitleaksFinding
 * @returns {Record<string, unknown> | null}
 */
export function mapGitleaksFinding(gitleaksFinding) {
  if (!gitleaksFinding || typeof gitleaksFinding !== 'object') return null;
  const f = /** @type {Record<string, unknown>} */ (gitleaksFinding);
  const file = typeof f.File === 'string' ? f.File : '';
  if (!file) return null;

  const startLine = Number.isFinite(f.StartLine) && f.StartLine >= 1
    ? Math.floor(/** @type {number} */ (f.StartLine))
    : null;
  const ruleId = typeof f.RuleID === 'string' && f.RuleID ? f.RuleID : 'unknown';
  const secretValue = typeof f.Secret === 'string' && f.Secret ? f.Secret : String(f.Match || '');
  const description =
    typeof f.Description === 'string' && f.Description.length > 0
      ? f.Description
      : `gitleaks rule "${ruleId}" matched.`;

  return {
    file,
    line: startLine,
    severity: 'critical',
    confidence: 'high',
    category: 'security',
    title: `Secret detected by gitleaks: ${ruleId}`,
    description,
    // Mask the secret in evidence so we don't re-leak it in the review comment.
    evidence: maskSecret(secretValue),
    suggestion: 'Remove the secret and rotate it immediately.',
    rule: `gitleaks:${ruleId}`,
  };
}

/**
 * Parse the JSON output of `gitleaks detect --report-format json` into an array
 * of normalized findings. Returns `[]` on any parse failure (never throws).
 *
 * Gitleaks emits either `[]` (no findings) or `[{...}, {...}]` at the top
 * level — NOT wrapped in `{findings: [...]}`.
 *
 * @param {string} jsonText
 * @returns {Array<Record<string, unknown>>}
 */
export function parseGitleaksJson(jsonText) {
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
    const mapped = mapGitleaksFinding(element);
    if (mapped) out.push(mapped);
  }
  return out;
}

/**
 * Scan added lines for secrets. Tries gitleaks first (via ensureBinary +
 * deps.runBinary); on ANY error warns via `deps.core.warning` and falls back
 * to `scanSecretsRegex(files)`. NEVER throws — the orchestrator relies on this
 * contract.
 *
 * @param {{ files: Array, repoPath: string, cacheDir?: string }} opts
 * @param {{
 *   ensureBinary?: Function,
 *   runBinary?: Function,
 *   platform?: string,
 *   arch?: string,
 *   core?: { warning?: (msg: string) => void, info?: (msg: string) => void },
 * }} [deps]
 * @returns {Promise<{ findings: Array, scanner: 'gitleaks' | 'regex-fallback' }>}
 */
export async function scanSecrets(opts, deps = {}) {
  const files = Array.isArray(opts?.files) ? opts.files : [];
  const core = deps.core;
  const platform = deps.platform || os.platform();
  const arch = deps.arch || os.arch();

  // Always compute the regex fallback up front so it's ready on any error path.
  const regexFindings = scanSecretsRegex(files);

  // No binary deps → fallback now (common in tests and when disabled).
  if (typeof deps.ensureBinary !== 'function' || typeof deps.runBinary !== 'function') {
    return { findings: regexFindings, scanner: 'regex-fallback' };
  }

  try {
    const asset = selectPlatformAsset(GITLEAKS_SPEC, { platform, arch });
    if (!asset) {
      throw new Error(
        `gitleaks: no asset for platform=${platform || '?'} arch=${arch || '?'}`,
      );
    }
    const binaryPath = await deps.ensureBinary(
      {
        ...GITLEAKS_SPEC,
        ...asset,
        cacheDir: opts.cacheDir,
        // gitleaks ships .tar.gz (mac/linux) and .zip (windows); pick by URL.
        extractor: pickExtractor(asset.url),
      },
      { platform, arch },
    );
    const source = opts.repoPath || process.cwd();
    // `--no-banner` suppresses the ASCII banner; `--report-format json` emits
    // a top-level array of findings to stdout; `--exit-code 0` (gitleaks uses
    // exit code 1 for "leaks found") is the trick — without it, finding-leaks
    // exits non-zero and runBinary may throw.
    const args = [
      'detect',
      '--source', source,
      '--report-format', 'json',
      '--no-banner',
      '--exit-code', '0',
      '--redact', // gitleaks redacts the matched secret in its output
    ];
    const result = await deps.runBinary(binaryPath, args, {
      cwd: source,
      maxBuffer: 10 * 1024 * 1024,
    });
    const stdout = typeof result === 'string' ? result : String(result?.stdout ?? '');
    const findings = parseGitleaksJson(stdout);
    if (core?.info) {
      core.info(`gitleaks: ${findings.length} secret finding(s).`);
    }
    return { findings, scanner: 'gitleaks' };
  } catch (err) {
    if (core?.warning) {
      core.warning(
        `gitleaks unavailable, using regex fallback: ${err?.message ?? String(err)}`,
      );
    }
    return { findings: regexFindings, scanner: 'regex-fallback' };
  }
}
