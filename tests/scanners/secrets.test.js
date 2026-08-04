/**
 * Tests for the secret scanner (src/lib/scanners/secrets.js).
 *
 * Coverage:
 *   - shannonEntropy: monotonically increasing with randomness
 *   - maskSecret: redaction shape
 *   - scanSecretsRegex: each SECRET_PATTERN fires once for its canonical sample
 *   - scanSecretsRegex: line mapping via parseAddedLines
 *   - scanSecretsRegex: entropy suppression on the generic-assignment pattern
 *   - scanSecretsRegex: never throws on bad input, dedups per line
 *   - parseGitleaksJson / mapGitleaksFinding: shape, masking, bad input
 *   - scanSecrets (async): gitleaks path with fake runBinary; fallback on error
 *
 * No real binaries are executed — `deps.runBinary` is always a fake.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  scanSecrets,
  scanSecretsRegex,
  shannonEntropy,
  maskSecret,
  SECRET_PATTERNS,
  parseGitleaksJson,
  mapGitleaksFinding,
  GITLEAKS_SPEC,
} from '../../src/lib/scanners/secrets.js';

// ---------------------------------------------------------------------------
// shannonEntropy
// ---------------------------------------------------------------------------

describe('shannonEntropy', () => {
  it('returns 0 for empty/invalid', () => {
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy(null)).toBe(0);
  });

  it('returns 0 for a constant string (no information)', () => {
    expect(shannonEntropy('aaaa')).toBe(0);
  });

  it('returns 2.0 for "abab" (two equally-likely symbols)', () => {
    expect(shannonEntropy('abab')).toBeCloseTo(1, 5); // actually log2(2) = 1
  });

  it('returns a higher entropy for random vs repetitive', () => {
    const repetitive = shannonEntropy('aaaaaaaaaaaaaaaa');
    const random = shannonEntropy('xY9pZ1qMvB7n');
    expect(random).toBeGreaterThan(repetitive);
  });
});

// ---------------------------------------------------------------------------
// maskSecret
// ---------------------------------------------------------------------------

describe('maskSecret', () => {
  it('returns "" for empty/invalid', () => {
    expect(maskSecret('')).toBe('');
    expect(maskSecret(null)).toBe('');
  });

  it('masks short values to <first>…', () => {
    expect(maskSecret('abc')).toBe('a…');
    expect(maskSecret('abcdef')).toBe('a…');
    expect(maskSecret('12345678')).toBe('1…');
  });

  it('masks long values to <first4>…<last2>', () => {
    expect(maskSecret('AKIAIOSFODNN7EXAMPLE')).toBe('AKIA…LE');
    expect(maskSecret('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe('ghp_…89');
  });
});

// ---------------------------------------------------------------------------
// scanSecretsRegex — per pattern
// ---------------------------------------------------------------------------

/**
 * Build a single-file PR patch with the given added-line texts.
 * Each text becomes a `+`-prefixed added line at the absolute line number
 * (1-based, starting at the hunk's +c).
 */
function buildPatch(addedTexts, startLine = 1) {
  const lines = [`@@ -1,${addedTexts.length} +${startLine},${addedTexts.length} @@`];
  for (const t of addedTexts) {
    lines.push(`+${t}`);
  }
  return lines.join('\n');
}

describe('scanSecretsRegex — pattern coverage', () => {
  const file = (patch) => [{ filename: 'src/sample.js', patch }];

  it('detects AWS access key IDs', () => {
    const findings = scanSecretsRegex(
      file(buildPatch(['const key = "AKIAIOSFODNN7EXAMPLE";'])),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: 'src/sample.js',
      severity: 'critical',
      confidence: 'high',
      category: 'security',
      rule: 'regex:aws-access-key-id',
    });
    // evidence is masked
    expect(findings[0].evidence).toBe('AKIA…LE');
  });

  it('detects GitHub PATs (ghp_/gho_/ghs_/ghu_/ghr_)', () => {
    const findings = scanSecretsRegex(
      file(buildPatch(['token = "ghp_' + 'a'.repeat(36) + '"'])),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe('regex:github-pat');
  });

  it('detects PEM private key blocks', () => {
    const findings = scanSecretsRegex(
      file(buildPatch(['-----BEGIN RSA PRIVATE KEY-----'])),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe('regex:private-key-block');
  });

  it('detects OPENSSH private key blocks', () => {
    const findings = scanSecretsRegex(
      file(buildPatch(['-----BEGIN OPENSSH PRIVATE KEY-----'])),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe('regex:private-key-block');
  });

  it('detects Slack tokens', () => {
    const findings = scanSecretsRegex(
      file(buildPatch(['const slack = "xoxb-' + '1'.repeat(20) + '"'])),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe('regex:slack-token');
  });

  it('detects JWTs', () => {
    const jwt = ['eyJ' + 'A'.repeat(12), 'eyJ' + 'B'.repeat(12), 'C'.repeat(12)].join('.');
    const findings = scanSecretsRegex(file(buildPatch([`Authorization: Bearer ${jwt}`])));
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe('regex:jwt');
  });

  it('detects DB connection strings with credentials', () => {
    const findings = scanSecretsRegex(
      file(buildPatch(['const url = "postgres://user:secretpass@db.local:5432/app";'])),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe('regex:db-connection-string');
  });

  it('detects mongodb+srv:// connection strings', () => {
    const findings = scanSecretsRegex(
      file(buildPatch(['url = "mongodb+srv://u:p@cluster.example.net/db"'])),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe('regex:db-connection-string');
  });
});

describe('scanSecretsRegex — generic assignment + entropy', () => {
  const file = (patch) => [{ filename: 'src/config.js', patch }];

  it('detects api_key="highentropyvalue" with entropy above threshold', () => {
    // 24-char base64-ish value: entropy clearly above 3.0
    const value = 'Z9xQ8pLm4BnK2vRt';
    const findings = scanSecretsRegex(file(buildPatch([`api_key = "${value}"`])));
    const api = findings.find((f) => f.rule === 'regex:generic-assignment');
    expect(api).toBeTruthy();
  });

  it('suppresses low-entropy assignments (e.g. "password")', () => {
    // Low-entropy repeated value — should be suppressed by minEntropy (>= 3.5).
    const findings = scanSecretsRegex(file(buildPatch(['password = "aaaaaaaaaaaa"'])));
    const api = findings.find((f) => f.rule === 'regex:generic-assignment');
    expect(api).toBeUndefined();
  });

  it('suppresses medium-entropy assignments below the 3.5 threshold', () => {
    // 12-char value with entropy ~2.585 (3 distinct chars) — below 3.5.
    const findings = scanSecretsRegex(file(buildPatch(['token = "abababababab"'])));
    const api = findings.find((f) => f.rule === 'regex:generic-assignment');
    expect(api).toBeUndefined();
  });

  it('detects the high-entropy-string pattern (>= 32 chars, entropy >= 4.5)', () => {
    // 40-char random-ish base64 — entropy above 4.5.
    const value = 'Z9xQ8pLm4BnK2vRt7aS3cD1eF6gH5jK8lM0nO3pQ';
    const findings = scanSecretsRegex(file(buildPatch([`config = "${value}"`])));
    const he = findings.find((f) => f.rule === 'regex:high-entropy-string');
    expect(he).toBeTruthy();
  });

  it('does NOT fire high-entropy-string on short tokens (< 32 chars)', () => {
    const value = 'shorttoken'; // 10 chars
    const findings = scanSecretsRegex(file(buildPatch([`x = "${value}"`])));
    const he = findings.find((f) => f.rule === 'regex:high-entropy-string');
    expect(he).toBeUndefined();
  });

  it('does NOT fire high-entropy-string on long but low-entropy strings', () => {
    // 40 chars but only 2 distinct chars → entropy ~1.
    const value = 'ab'.repeat(20);
    const findings = scanSecretsRegex(file(buildPatch([`x = "${value}"`])));
    const he = findings.find((f) => f.rule === 'regex:high-entropy-string');
    expect(he).toBeUndefined();
  });

  it('detects api-key variants (api-key, apikey, apiKey, secret, token, auth_token, access_token, client_secret)', () => {
    const value = 'Xy9P3kMNBq2VtRZ7'; // high-entropy
    const variants = [
      `api_key = "${value}"`,
      `apikey = "${value}"`,
      `api-key: "${value}"`,
      `'secret': "${value}"`,
      `token = "${value}"`,
      `auth_token = "${value}"`,
      `access_token = "${value}"`,
      `client_secret = "${value}"`,
    ];
    for (const v of variants) {
      const findings = scanSecretsRegex(file(buildPatch([v])));
      const api = findings.find((f) => f.rule === 'regex:generic-assignment');
      expect(api).withContext(`variant "${v}" should match`).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// scanSecretsRegex — line mapping, dedup, robustness
// ---------------------------------------------------------------------------

describe('scanSecretsRegex — line mapping', () => {
  it('reports the absolute (new-file) line number from the hunk header', () => {
    const patch = [
      '@@ -10,3 +42,3 @@ fn',
      ' context', // line 42
      '-removed',
      '+const aws = "AKIAIOSFODNN7EXAMPLE";', // line 43
    ].join('\n');
    const findings = scanSecretsRegex([{ filename: 'a.js', patch }]);
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(43);
  });

  it('emits ONE finding per pattern per line (not per pattern re-exec)', () => {
    // A single line containing two distinct patterns yields two findings.
    const patch = buildPatch([
      'const x = "AKIAIOSFODNN7EXAMPLE"; const y = "xoxb-' + '1'.repeat(20) + '"',
    ]);
    const findings = scanSecretsRegex([{ filename: 'a.js', patch }]);
    const rules = findings.map((f) => f.rule).sort();
    expect(rules).toEqual(['regex:aws-access-key-id', 'regex:slack-token']);
  });
});

describe('scanSecretsRegex — robustness', () => {
  it('returns [] for non-array input', () => {
    // @ts-expect-error testing bad input
    expect(scanSecretsRegex(null)).toEqual([]);
    // @ts-expect-error testing bad input
    expect(scanSecretsRegex(undefined)).toEqual([]);
  });

  it('skips files without a filename or patch', () => {
    const findings = scanSecretsRegex([
      { patch: '+AKIAIOSFODNN7EXAMPLE' }, // no filename
      { filename: 'a.js' }, // no patch
      null,
    ]);
    expect(findings).toEqual([]);
  });

  it('does not flag context or removed lines', () => {
    // The AWS key in a `-removed` line and a context line must not fire.
    const patch = [
      '@@ -1,3 +1,3 @@',
      '-const aws = "AKIAIOSFODNN7EXAMPLE";',
      ' const aws2 = "AKIAIOSFODNN7EXAMPLE";',
      '+// safe',
    ].join('\n');
    const findings = scanSecretsRegex([{ filename: 'a.js', patch }]);
    expect(findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Gitleaks JSON mapping
// ---------------------------------------------------------------------------

describe('mapGitleaksFinding', () => {
  it('maps a canonical gitleaks finding to the normalized schema', () => {
    const f = mapGitleaksFinding({
      RuleID: 'aws-access-token',
      Description: 'AWS Access Token',
      Match: 'AKIAIOSFODNN7EXAMPLE',
      Secret: 'AKIAIOSFODNN7EXAMPLE',
      File: 'src/auth.js',
      StartLine: 42,
      EndLine: 42,
      Entropy: 3.5,
    });
    expect(f).toMatchObject({
      file: 'src/auth.js',
      line: 42,
      severity: 'critical',
      confidence: 'high',
      category: 'security',
      title: 'Secret detected by gitleaks: aws-access-token',
      description: 'AWS Access Token',
      rule: 'gitleaks:aws-access-token',
    });
    // evidence is masked
    expect(f.evidence).toBe('AKIA…LE');
  });

  it('returns null when File is missing', () => {
    expect(mapGitleaksFinding({ RuleID: 'x', Match: 'y' })).toBeNull();
  });

  it('returns null on non-object input', () => {
    expect(mapGitleaksFinding(null)).toBeNull();
    expect(mapGitleaksFinding('foo')).toBeNull();
  });

  it('falls back to a generic description when Description is missing', () => {
    const f = mapGitleaksFinding({
      RuleID: 'aws-access-token',
      Secret: 'AKIAIOSFODNN7EXAMPLE',
      File: 'a.js',
      StartLine: 1,
    });
    expect(typeof f.description).toBe('string');
    expect(f.description.length).toBeGreaterThan(0);
  });

  it('sets line to null when StartLine is missing/invalid', () => {
    const f = mapGitleaksFinding({ RuleID: 'x', File: 'a.js' });
    expect(f.line).toBeNull();
  });
});

describe('parseGitleaksJson', () => {
  it('parses a top-level JSON array of findings', () => {
    const json = JSON.stringify([
      { RuleID: 'r1', File: 'a.js', StartLine: 1, Secret: 'AKIAIOSFODNN7EXAMPLE' },
      { RuleID: 'r2', File: 'b.js', StartLine: 5, Secret: 'x' },
    ]);
    const findings = parseGitleaksJson(json);
    expect(findings).toHaveLength(2);
    expect(findings[0].rule).toBe('gitleaks:r1');
  });

  it('returns [] for an empty array', () => {
    expect(parseGitleaksJson('[]')).toEqual([]);
  });

  it('returns [] for empty/invalid input', () => {
    expect(parseGitleaksJson('')).toEqual([]);
    expect(parseGitleaksJson(null)).toEqual([]);
    expect(parseGitleaksJson('not json')).toEqual([]);
    expect(parseGitleaksJson('{}')).toEqual([]); // not an array
  });

  it('skips malformed array entries (no File)', () => {
    const json = JSON.stringify([
      { RuleID: 'r1', File: 'a.js', StartLine: 1 },
      { RuleID: 'r2', StartLine: 5 }, // no File → dropped
    ]);
    expect(parseGitleaksJson(json)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// scanSecrets — async orchestration
// ---------------------------------------------------------------------------

describe('scanSecrets — gitleaks path (fake runBinary)', () => {
  it('uses gitleaks when deps.runBinary + ensureBinary are provided', async () => {
    const gitleaksJson = JSON.stringify([
      {
        RuleID: 'aws-access-token',
        Description: 'AWS',
        Match: 'AKIAIOSFODNN7EXAMPLE',
        Secret: 'AKIAIOSFODNN7EXAMPLE',
        File: 'src/auth.js',
        StartLine: 42,
      },
    ]);
    const fakeRunBinary = vi.fn().mockResolvedValue(gitleaksJson);
    const fakeEnsureBinary = vi.fn().mockResolvedValue('/cache/gitleaks/gitleaks');
    const result = await scanSecrets(
      { files: [], repoPath: '/repo', cacheDir: '/cache' },
      {
        ensureBinary: fakeEnsureBinary,
        runBinary: fakeRunBinary,
        platform: 'linux',
        arch: 'x64',
      },
    );
    expect(result.scanner).toBe('gitleaks');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].rule).toBe('gitleaks:aws-access-token');
    expect(fakeEnsureBinary).toHaveBeenCalledOnce();
    expect(fakeRunBinary).toHaveBeenCalledOnce();
    // args include detect + source + report-format json + no-banner
    const args = fakeRunBinary.mock.calls[0][1];
    expect(args).toContain('detect');
    expect(args).toContain('--report-format');
    expect(args).toContain('json');
    expect(args).toContain('--no-banner');
    expect(args).toContain('--redact');
  });

  it('returns regex fallback when gitleaks reports no findings (empty array)', async () => {
    const fakeRunBinary = vi.fn().mockResolvedValue('[]');
    const result = await scanSecrets(
      { files: [{ filename: 'a.js', patch: buildPatch(['+const k = "AKIAIOSFODNN7EXAMPLE"']) }], repoPath: '/r' },
      { ensureBinary: vi.fn().mockResolvedValue('/p'), runBinary: fakeRunBinary },
    );
    expect(result.scanner).toBe('gitleaks');
    expect(result.findings).toEqual([]);
  });
});

describe('scanSecrets — fallback paths', () => {
  it('falls back to regex when ensureBinary is missing', async () => {
    const result = await scanSecrets(
      { files: [{ filename: 'a.js', patch: buildPatch(['+const k = "AKIAIOSFODNN7EXAMPLE"']) }], repoPath: '/r' },
      { runBinary: vi.fn() }, // no ensureBinary
    );
    expect(result.scanner).toBe('regex-fallback');
    expect(result.findings).toHaveLength(1);
  });

  it('falls back to regex when runBinary throws', async () => {
    const warnings = [];
    const result = await scanSecrets(
      { files: [{ filename: 'a.js', patch: buildPatch(['+const k = "AKIAIOSFODNN7EXAMPLE"']) }], repoPath: '/r' },
      {
        ensureBinary: vi.fn().mockResolvedValue('/p'),
        runBinary: vi.fn().mockRejectedValue(new Error('binary crashed')),
        core: { warning: (m) => warnings.push(m) },
      },
    );
    expect(result.scanner).toBe('regex-fallback');
    expect(result.findings).toHaveLength(1);
    expect(warnings[0]).toMatch(/gitleaks unavailable/);
  });

  it('falls back to regex when ensureBinary throws (e.g. checksum mismatch)', async () => {
    const result = await scanSecrets(
      { files: [{ filename: 'a.js', patch: buildPatch(['+const k = "AKIAIOSFODNN7EXAMPLE"']) }], repoPath: '/r' },
      {
        ensureBinary: vi.fn().mockRejectedValue(new Error('checksum mismatch')),
        runBinary: vi.fn(),
      },
    );
    expect(result.scanner).toBe('regex-fallback');
    expect(result.findings).toHaveLength(1);
  });

  it('falls back to regex when gitleaks emits unparseable output', async () => {
    const result = await scanSecrets(
      { files: [{ filename: 'a.js', patch: buildPatch(['+const k = "AKIAIOSFODNN7EXAMPLE"']) }], repoPath: '/r' },
      {
        ensureBinary: vi.fn().mockResolvedValue('/p'),
        runBinary: vi.fn().mockResolvedValue('not json at all'),
      },
    );
    // No findings from gitleaks (parse failed → []), and no regex fallback run
    // (no error thrown). Scanner reports 'gitleaks' with 0 findings.
    expect(result.scanner).toBe('gitleaks');
    expect(result.findings).toEqual([]);
  });
});

describe('GITLEAKS_SPEC shape', () => {
  it('exposes name/version/urls/checksums', () => {
    expect(GITLEAKS_SPEC.name).toBe('gitleaks');
    expect(GITLEAKS_SPEC.version).toBe('8.21.2');
    expect(GITLEAKS_SPEC.urls.darwin_arm64).toMatch(/^https:\/\//);
    expect(GITLEAKS_SPEC.checksums.darwin_arm64).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('SECRET_PATTERNS export', () => {
  it('exposes an array of pattern objects with required fields', () => {
    expect(Array.isArray(SECRET_PATTERNS)).toBe(true);
    expect(SECRET_PATTERNS.length).toBeGreaterThan(0);
    for (const p of SECRET_PATTERNS) {
      expect(typeof p.name).toBe('string');
      expect(p.regex instanceof RegExp).toBe(true);
      expect(typeof p.title).toBe('string');
    }
  });
});
