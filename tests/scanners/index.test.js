/**
 * Tests for the scanner orchestrator (src/lib/scanners/index.js).
 *
 * Each scanner is injected as a fake — no real secrets/patterns/metrics
 * scanner runs. Verifies orchestration, concurrency (Promise.all), dedup,
 * master switch + per-scanner repo toggles, and the context formatter.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runScanners,
  formatScannerContext,
} from '../../src/lib/scanners/index.js';
import { computeMetrics } from '../../src/lib/scanners/metrics.js';

// ---------------------------------------------------------------------------
// Helpers — fakes that return canned results
// ---------------------------------------------------------------------------

const fakeSecretsScanner = (findings = [], scanner = 'gitleaks') =>
  vi.fn().mockResolvedValue({ findings, scanner });

const fakePatternsScanner = (findings = [], scanner = 'ast-grep') =>
  vi.fn().mockResolvedValue({ findings, scanner });

const baseOpts = (overrides = {}) => ({
  files: [{ filename: 'a.js', patch: '@@ -1,1 +1,1 @@\n+x' }],
  repoPath: '/repo',
  cacheDir: '/cache',
  config: { scannersEnabled: true },
  repoConfig: {},
  ...overrides,
});

// ---------------------------------------------------------------------------
// formatScannerContext
// ---------------------------------------------------------------------------

describe('formatScannerContext', () => {
  it('returns "" for empty findings and no metrics', () => {
    expect(formatScannerContext([], null)).toBe('');
    expect(formatScannerContext([], undefined)).toBe('');
  });

  it('lists findings with file:line [rule] title', () => {
    const findings = [
      { file: 'src/auth.js', line: 42, rule: 'gitleaks:aws-access-key', title: 'AWS access key ID detected' },
      { file: 'src/db.js', line: 18, rule: 'astgrep:sql-concat', title: 'SQL query via string concatenation' },
    ];
    const out = formatScannerContext(findings, null);
    expect(out.split('\n')).toEqual([
      'Already detected by automated scanners (do NOT re-report these):',
      '- src/auth.js:42 [gitleaks:aws-access-key] AWS access key ID detected',
      '- src/db.js:18 [astgrep:sql-concat] SQL query via string concatenation',
    ]);
  });

  it('omits :line when line is null', () => {
    const findings = [
      { file: 'package-lock.json', line: null, rule: 'metrics:generated-file', title: 'Generated/lock file modified' },
    ];
    const out = formatScannerContext(findings, null);
    expect(out).toContain('- package-lock.json [metrics:generated-file]');
  });

  it('appends a metrics line at the end (separated by blank line)', () => {
    const metrics = computeMetrics([{ filename: 'a.js', additions: 10, deletions: 2 }]);
    const findings = [
      { file: 'a.js', line: 1, rule: 'x:y', title: 't' },
    ];
    const out = formatScannerContext(findings, metrics);
    expect(out).toContain('PR metrics:');
    expect(out).toContain('1 files (+10 -2)');
  });

  it('emits metrics-only when no findings', () => {
    const metrics = computeMetrics([{ filename: 'a.js' }]);
    const out = formatScannerContext([], metrics);
    expect(out).toMatch(/^PR metrics:/);
  });
});

// ---------------------------------------------------------------------------
// runScanners — orchestration
// ---------------------------------------------------------------------------

describe('runScanners — master switch', () => {
  it('returns empty findings + scannerNames=[] when master disabled', async () => {
    const secrets = fakeSecretsScanner([{ file: 'a', line: 1, rule: 's', title: 't' }]);
    const patterns = fakePatternsScanner();
    const r = await runScanners(
      baseOpts({ config: { scannersEnabled: false } }),
      { scanSecrets: secrets, scanPatterns: patterns },
    );
    expect(r.findings).toEqual([]);
    expect(r.scannerNames).toEqual([]);
    expect(secrets).not.toHaveBeenCalled();
    expect(patterns).not.toHaveBeenCalled();
  });

  it('runs both scanners when master enabled (default)', async () => {
    const secrets = fakeSecretsScanner();
    const patterns = fakePatternsScanner();
    const r = await runScanners(
      baseOpts({ config: {} }), // scannersEnabled defaults to true
      { scanSecrets: secrets, scanPatterns: patterns },
    );
    expect(secrets).toHaveBeenCalledOnce();
    expect(patterns).toHaveBeenCalledOnce();
    expect(r.scannerNames).toEqual(['secrets:gitleaks', 'patterns:ast-grep']);
  });
});

describe('runScanners — per-scanner repo toggles', () => {
  it('skips secrets when repoConfig.scanners.secrets === false', async () => {
    const secrets = fakeSecretsScanner();
    const patterns = fakePatternsScanner();
    const r = await runScanners(
      baseOpts({ repoConfig: { scanners: { secrets: false } } }),
      { scanSecrets: secrets, scanPatterns: patterns },
    );
    expect(secrets).not.toHaveBeenCalled();
    expect(patterns).toHaveBeenCalledOnce();
    expect(r.scannerNames).toEqual(['patterns:ast-grep']);
  });

  it('skips patterns when repoConfig.scanners.patterns === false', async () => {
    const secrets = fakeSecretsScanner();
    const patterns = fakePatternsScanner();
    const r = await runScanners(
      baseOpts({ repoConfig: { scanners: { patterns: false } } }),
      { scanSecrets: secrets, scanPatterns: patterns },
    );
    expect(secrets).toHaveBeenCalledOnce();
    expect(patterns).not.toHaveBeenCalled();
    expect(r.scannerNames).toEqual(['secrets:gitleaks']);
  });

  it('treats non-false values as enabled (cannot disable by accident)', async () => {
    const secrets = fakeSecretsScanner();
    const patterns = fakePatternsScanner();
    await runScanners(
      baseOpts({ repoConfig: { scanners: { secrets: null, patterns: 'false' } } }),
      { scanSecrets: secrets, scanPatterns: patterns },
    );
    expect(secrets).toHaveBeenCalledOnce();
    // 'false' (string) is not === false → patterns still run
    expect(patterns).toHaveBeenCalledOnce();
  });

  it('skips metrics-driven findings when repoConfig.scanners.metrics === false', async () => {
    const secrets = fakeSecretsScanner();
    const patterns = fakePatternsScanner();
    const fakeMetrics = vi.fn(() => ({
      filesChanged: 1,
      additions: 0,
      deletions: 0,
      testFiles: 0,
      sourceFiles: 1,
      testToSourceRatio: 0,
      largeFiles: ['big.js'],
      generatedFiles: [],
      todoCount: 0,
      byStatus: { modified: 1 },
    }));
    const fakeMetricsToFindings = vi.fn((m) => [
      { file: 'big.js', line: null, rule: 'metrics:large-file', title: 't' },
    ]);
    const r = await runScanners(
      baseOpts({
        files: [{ filename: 'big.js', changes: 500 }],
        repoConfig: { scanners: { metrics: false } },
      }),
      {
        scanSecrets: secrets,
        scanPatterns: patterns,
        computeMetrics: fakeMetrics,
        metricsToFindings: fakeMetricsToFindings,
      },
    );
    expect(fakeMetrics).toHaveBeenCalledOnce(); // metrics always computed
    expect(fakeMetricsToFindings).not.toHaveBeenCalled(); // but not surfaced
    expect(r.scannerNames).not.toContain('metrics:info');
  });
});

describe('runScanners — concurrency & merge', () => {
  it('runs secrets and patterns concurrently (Promise.all)', async () => {
    const order = [];
    const secrets = vi.fn(async () => {
      order.push('secrets-start');
      await new Promise((r) => setTimeout(r, 5));
      order.push('secrets-end');
      return { findings: [], scanner: 'gitleaks' };
    });
    const patterns = vi.fn(async () => {
      order.push('patterns-start');
      await new Promise((r) => setTimeout(r, 5));
      order.push('patterns-end');
      return { findings: [], scanner: 'ast-grep' };
    });
    await runScanners(baseOpts(), { scanSecrets: secrets, scanPatterns: patterns });
    // Both should start before either ends (interleaved).
    expect(order.indexOf('secrets-start')).toBeLessThan(order.indexOf('patterns-end'));
    expect(order.indexOf('patterns-start')).toBeLessThan(order.indexOf('secrets-end'));
  });

  it('merges findings from both scanners', async () => {
    const secrets = fakeSecretsScanner([
      { file: 'a.js', line: 1, rule: 'gitleaks:x', title: 's' },
    ]);
    const patterns = fakePatternsScanner([
      { file: 'a.js', line: 2, rule: 'astgrep:y', title: 'p' },
    ]);
    const r = await runScanners(baseOpts(), {
      scanSecrets: secrets,
      scanPatterns: patterns,
    });
    expect(r.findings).toHaveLength(2);
  });
});

describe('runScanners — dedup', () => {
  it('dedups findings with the same file+line+rule (first wins)', async () => {
    const secrets = fakeSecretsScanner([
      { file: 'a.js', line: 1, rule: 'gitleaks:x', title: 's1' },
      { file: 'a.js', line: 1, rule: 'gitleaks:x', title: 's2 (dup)' },
    ]);
    const patterns = fakePatternsScanner([
      { file: 'a.js', line: 1, rule: 'gitleaks:x', title: 's3 (dup)' },
    ]);
    const r = await runScanners(baseOpts(), {
      scanSecrets: secrets,
      scanPatterns: patterns,
    });
    const same = r.findings.filter(
      (f) => f.file === 'a.js' && f.line === 1 && f.rule === 'gitleaks:x',
    );
    expect(same).toHaveLength(1);
    expect(same[0].title).toBe('s1'); // first wins
  });

  it('keeps distinct findings at the same line (different rules)', async () => {
    const secrets = fakeSecretsScanner([
      { file: 'a.js', line: 1, rule: 'gitleaks:foo', title: 's' },
    ]);
    const patterns = fakePatternsScanner([
      { file: 'a.js', line: 1, rule: 'astgrep:bar', title: 'p' },
    ]);
    const r = await runScanners(baseOpts(), {
      scanSecrets: secrets,
      scanPatterns: patterns,
    });
    expect(r.findings).toHaveLength(2);
  });
});

describe('runScanners — metrics', () => {
  it('always computes metrics (even with master disabled)', async () => {
    const fakeMetrics = vi.fn(() => ({ filesChanged: 0 }));
    const r = await runScanners(
      baseOpts({ config: { scannersEnabled: false } }),
      { computeMetrics: fakeMetrics },
    );
    expect(fakeMetrics).toHaveBeenCalledOnce();
    expect(r.metrics).toEqual({ filesChanged: 0 });
  });

  it('surfaces large/generated files as findings', async () => {
    const secrets = fakeSecretsScanner();
    const patterns = fakePatternsScanner();
    const r = await runScanners(
      baseOpts({
        files: [
          { filename: 'big.js', changes: 500 },
          { filename: 'package-lock.json' },
          { filename: 'src/x.js', additions: 5 },
        ],
      }),
      { scanSecrets: secrets, scanPatterns: patterns },
    );
    const rules = r.findings.map((f) => f.rule).sort();
    expect(rules).toContain('metrics:large-file');
    expect(rules).toContain('metrics:generated-file');
  });
});

describe('runScanners — robustness', () => {
  it('returns [] findings and a warning when scanSecrets throws', async () => {
    const warnings = [];
    const secrets = vi.fn().mockRejectedValue(new Error('boom'));
    const patterns = fakePatternsScanner([
      { file: 'a.js', line: 1, rule: 'astgrep:x', title: 'p' },
    ]);
    const r = await runScanners(
      baseOpts(),
      {
        scanSecrets: secrets,
        scanPatterns: patterns,
        core: { warning: (m) => warnings.push(m) },
      },
    );
    expect(r.scannerNames).toContain('patterns:ast-grep');
    expect(r.findings).toHaveLength(1);
    expect(warnings[0]).toMatch(/secrets scanner failed/);
  });

  it('returns [] findings and a warning when scanPatterns throws', async () => {
    const warnings = [];
    const secrets = fakeSecretsScanner([
      { file: 'a.js', line: 1, rule: 'gitleaks:x', title: 's' },
    ]);
    const patterns = vi.fn().mockRejectedValue(new Error('boom'));
    const r = await runScanners(
      baseOpts(),
      {
        scanSecrets: secrets,
        scanPatterns: patterns,
        core: { warning: (m) => warnings.push(m) },
      },
    );
    expect(r.scannerNames).toContain('secrets:gitleaks');
    expect(r.findings).toHaveLength(1);
    expect(warnings[0]).toMatch(/patterns scanner failed/);
  });

  it('handles empty files array', async () => {
    const secrets = fakeSecretsScanner();
    const patterns = fakePatternsScanner();
    const r = await runScanners(
      baseOpts({ files: [] }),
      { scanSecrets: secrets, scanPatterns: patterns },
    );
    expect(r.findings).toEqual([]);
    expect(r.metrics.filesChanged).toBe(0);
  });

  it('handles missing opts gracefully', async () => {
    const secrets = fakeSecretsScanner();
    const patterns = fakePatternsScanner();
    // @ts-expect-error testing missing opts
    const r = await runScanners({}, { scanSecrets: secrets, scanPatterns: patterns });
    expect(r.findings).toEqual([]);
    expect(r.scannerNames).toEqual(['secrets:gitleaks', 'patterns:ast-grep']);
  });
});
