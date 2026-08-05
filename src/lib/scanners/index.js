/**
 * Scanner orchestrator — runs every enabled scanner and merges results.
 *
 * Architecture — the injection seam:
 *   Each scanner (`scanSecrets`, `scanPatterns`, `computeMetrics`) is injected
 *   via `deps` so tests can substitute fakes. The orchestrator itself does NO
 *   I/O and NEVER throws — a scanner failure logs a warning and contributes an
 *   empty findings array.
 *
 * Flow:
 *   1. Filter by the master switch (`config.scannersEnabled`, default true).
 *   2. Filter by per-scanner repo toggles (`repoConfig.scanners.{name}` can
 *      DISABLE a scanner; it cannot enable one the master switch turned off).
 *   3. Run `scanSecrets` and `scanPatterns` concurrently via `Promise.all`.
 *   4. Run `computeMetrics` (sync).
 *   5. Surface `metricsToFindings(metrics)` as low-severity findings.
 *   6. Merge all findings; dedup by `${file}:${line}:${rule}`.
 *   7. Return `{ findings, metrics, scannerNames }`.
 *
 * @module src/lib/scanners/index.js
 */

import { scanSecrets } from './secrets.js';
import { scanPatterns } from './patterns.js';
import {
  computeMetrics,
  metricsToFindings,
  formatMetricsForPrompt,
} from './metrics.js';

/**
 * Build a dedup key for a finding: `${file}:${line}:${rule}`.
 *
 * @param {Record<string, unknown>} f
 * @returns {string}
 */
function dedupKey(f) {
  const file = typeof f.file === 'string' ? f.file : '';
  const line = f.line === null || f.line === undefined ? 'null' : f.line;
  const rule = typeof f.rule === 'string' ? f.rule : '';
  return `${file}:${line}:${rule}`;
}

/**
 * Format the deterministic scanner findings + metrics as a compact context
 * block for the LLM prompt. The prompt instructs the model NOT to re-report
 * these.
 *
 * Output shape:
 * ```
 * Already detected by automated scanners (do NOT re-report these):
 * - src/auth.js:42 [gitleaks:aws-access-key] AWS access key ID detected
 * - src/db.js:18 [astgrep:sql-concat] SQL query via string concatenation
 *
 * PR metrics: 12 files (+340 -89), test-to-source ratio 0.30, 2 large files, 4 TODOs.
 * ```
 *
 * Empty findings + empty metrics → '' (so the prompt-builder omits the block).
 *
 * @param {Array<Record<string, unknown>>} findings
 * @param {ReturnType<typeof computeMetrics>} metrics
 * @returns {string}
 */
export function formatScannerContext(findings, metrics) {
  /** @type {string[]} */
  const lines = [];
  if (Array.isArray(findings) && findings.length > 0) {
    lines.push('Already detected by automated scanners (do NOT re-report these):');
    for (const f of findings) {
      const file = typeof f.file === 'string' ? f.file : '';
      const line = typeof f.line === 'number' && f.line > 0 ? `:${f.line}` : '';
      const rule = typeof f.rule === 'string' && f.rule ? `[${f.rule}]` : '';
      const title = typeof f.title === 'string' ? f.title : '';
      lines.push(`- ${file}${line} ${rule} ${title}`.trim());
    }
  }
  if (metrics && typeof metrics === 'object') {
    const m = formatMetricsForPrompt(metrics);
    if (m) {
      if (lines.length > 0) lines.push('');
      lines.push(`PR metrics: ${m}`);
    }
  }
  return lines.join('\n');
}

/**
 * Run all enabled scanners. Each scanner is injected via deps for testability.
 *
 * @param {{
 *   files: Array,
 *   repoPath?: string,
 *   cacheDir?: string,
 *   config?: { scannersEnabled?: boolean },
 *   repoConfig?: { scanners?: { secrets?: boolean, patterns?: boolean, metrics?: boolean } },
 * }} opts
 * @param {{
 *   scanSecrets?: Function,
 *   scanPatterns?: Function,
 *   computeMetrics?: Function,
 *   metricsToFindings?: Function,
 *   ensureBinary?: Function,
 *   runBinary?: Function,
 *   platform?: string,
 *   arch?: string,
 *   core?: { warning?: (msg: string) => void, info?: (msg: string) => void },
 * }} [deps]
 * @returns {Promise<{ findings: Array, metrics: Object, scannerNames: string[] }>}
 */
export async function runScanners(opts, deps = {}) {
  const files = Array.isArray(opts?.files) ? opts.files : [];
  const config = opts?.config && typeof opts?.config === 'object' ? opts.config : {};
  const repoConfig =
    opts?.repoConfig && typeof opts?.repoConfig === 'object' ? opts.repoConfig : {};
  const repoScanners = repoConfig.scanners && typeof repoConfig.scanners === 'object'
    ? repoConfig.scanners
    : {};
  const core = deps.core;

  const doComputeMetrics =
    typeof deps.computeMetrics === 'function' ? deps.computeMetrics : computeMetrics;
  // Metrics are always computed — they're cheap and pure and feed the prompt
  // context block even when scanning is disabled.
  const metrics = doComputeMetrics(files);

  const masterEnabled = config.scannersEnabled !== false; // default true
  if (!masterEnabled) {
    return { findings: [], metrics, scannerNames: [] };
  }

  const doScanSecrets = typeof deps.scanSecrets === 'function' ? deps.scanSecrets : scanSecrets;
  const doScanPatterns = typeof deps.scanPatterns === 'function' ? deps.scanPatterns : scanPatterns;
  const doMetricsToFindings =
    typeof deps.metricsToFindings === 'function' ? deps.metricsToFindings : metricsToFindings;

  // Per-scanner repo toggles: a repo can DISABLE (explicit false) but not enable.
  const secretsEnabled = repoScanners.secrets !== false;
  const patternsEnabled = repoScanners.patterns !== false;
  // metrics scanner is cheap and pure — always run unless explicitly disabled.
  const metricsEnabled = repoScanners.metrics !== false;

  const scannerNames = [];
  /** @type {Array<Record<string, unknown>>} */
  let findings = [];

  // Per-scanner deps: forward ensureBinary/runBinary so production actually
  // attempts the binary path. Tests that don't supply these fall through to
  // the regex fallback inside each scanner. We only set the keys when they're
  // actually functions so the scanner-side `typeof deps.ensureBinary`
  // guard cleanly detects the absent case.
  const scannerSharedDeps = { core };
  if (typeof deps.ensureBinary === 'function') {
    scannerSharedDeps.ensureBinary = deps.ensureBinary;
  }
  if (typeof deps.runBinary === 'function') {
    scannerSharedDeps.runBinary = deps.runBinary;
  }
  if (typeof deps.platform === 'string') {
    scannerSharedDeps.platform = deps.platform;
  }
  if (typeof deps.arch === 'string') {
    scannerSharedDeps.arch = deps.arch;
  }

  // Run secrets + patterns concurrently.
  /** @type {Array<Promise<{ findings: Array, scanner: string }>>} */
  const promises = [];
  if (secretsEnabled) {
    promises.push(
      doScanSecrets(
        { files, repoPath: opts.repoPath, cacheDir: opts.cacheDir },
        scannerSharedDeps,
      ).catch((err) => {
        if (core?.warning) {
          core.warning(`secrets scanner failed: ${err?.message ?? String(err)}`);
        }
        return { findings: [], scanner: 'regex-fallback' };
      }),
    );
  }
  if (patternsEnabled) {
    promises.push(
      doScanPatterns(
        { files, repoPath: opts.repoPath, cacheDir: opts.cacheDir },
        scannerSharedDeps,
      ).catch((err) => {
        if (core?.warning) {
          core.warning(`patterns scanner failed: ${err?.message ?? String(err)}`);
        }
        return { findings: [], scanner: 'regex-fallback' };
      }),
    );
  }
  const results = await Promise.all(promises);

  // Track provenance.
  if (secretsEnabled) {
    const r = results.shift();
    if (r) {
      scannerNames.push(`secrets:${r.scanner}`);
      findings = findings.concat(r.findings);
    }
  }
  if (patternsEnabled) {
    const r = results.shift();
    if (r) {
      scannerNames.push(`patterns:${r.scanner}`);
      findings = findings.concat(r.findings);
    }
  }

  // Surface metrics-driven findings (large/generated files).
  if (metricsEnabled) {
    const mFindings = doMetricsToFindings(metrics);
    if (mFindings.length > 0) {
      scannerNames.push('metrics:info');
      findings = findings.concat(mFindings);
    }
  }

  // Dedup by file+line+rule (first wins).
  const seen = new Set();
  /** @type {Array<Record<string, unknown>>} */
  const deduped = [];
  for (const f of findings) {
    const key = dedupKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(f);
  }

  return { findings: deduped, metrics, scannerNames };
}
