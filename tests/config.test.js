import { loadConfig } from '../src/lib/config.js';

// Helper: build an inputs object from a plain object (only defined keys).
const inputs = (obj) => obj;

describe('loadConfig — apiKey (required)', () => {
  test('throws when ZAI_API_KEY is empty/missing', () => {
    expect(() => loadConfig({})).toThrow('ZAI_API_KEY is required');
    expect(() => loadConfig({ ZAI_API_KEY: '' })).toThrow('ZAI_API_KEY is required');
    expect(() => loadConfig({ ZAI_API_KEY: '   ' })).toThrow('ZAI_API_KEY is required');
  });

  test('accepts a provided key (trimmed)', () => {
    const cfg = loadConfig({ ZAI_API_KEY: 'sk-secret' });
    expect(cfg.apiKey).toBe('sk-secret');
  });
});

describe('loadConfig — string fields & defaults', () => {
  test('model defaults to glm-5.2', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k' }).model).toBe('glm-5.2');
  });
  test('model uses provided value', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_MODEL: 'glm-4.6' }).model).toBe('glm-4.6');
  });

  test('systemPrompt defaults to empty string', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k' }).systemPrompt).toBe('');
  });
  test('systemPrompt uses provided value', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_SYSTEM_PROMPT: 'be harsh' }).systemPrompt).toBe('be harsh');
  });

  test('reviewerName defaults to "Z.ai Code Review"', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k' }).reviewerName).toBe('Z.ai Code Review');
  });
  test('reviewerName uses provided value', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_REVIEWER_NAME: 'Bot' }).reviewerName).toBe('Bot');
  });

  test('githubToken defaults to empty string', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k' }).githubToken).toBe('');
  });
  test('githubToken uses provided value', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', GITHUB_TOKEN: 'ghp_xxx' }).githubToken).toBe('ghp_xxx');
  });
});

describe('loadConfig — excludePatterns', () => {
  test('default when input empty', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k' }).excludePatterns).toEqual([
      '*.lock',
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
    ]);
  });
  test('split on comma, trim, drop empties', () => {
    expect(
      loadConfig({ ZAI_API_KEY: 'k', EXCLUDE_PATTERNS: '*.log , , dist/** ,' }).excludePatterns,
    ).toEqual(['*.log', 'dist/**']);
  });
});

describe('loadConfig — numeric fields & defaults', () => {
  test('maxDiffChars: default 100000; 0 means unlimited; NaN/negative -> default', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k' }).maxDiffChars).toBe(100000);
    expect(loadConfig({ ZAI_API_KEY: 'k', MAX_DIFF_CHARS: '50000' }).maxDiffChars).toBe(50000);
    expect(loadConfig({ ZAI_API_KEY: 'k', MAX_DIFF_CHARS: '0' }).maxDiffChars).toBe(0); // unlimited
    expect(loadConfig({ ZAI_API_KEY: 'k', MAX_DIFF_CHARS: 'abc' }).maxDiffChars).toBe(100000); // NaN->default
    expect(loadConfig({ ZAI_API_KEY: 'k', MAX_DIFF_CHARS: '12.9' }).maxDiffChars).toBe(12);
    expect(loadConfig({ ZAI_API_KEY: 'k', MAX_DIFF_CHARS: '-5' }).maxDiffChars).toBe(100000); // negative->default
  });

  test('largePrFileThreshold default 50', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k' }).largePrFileThreshold).toBe(50);
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_LARGE_PR_FILE_THRESHOLD: '100' }).largePrFileThreshold).toBe(100);
  });

  test('maxBatchChars default 120000', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k' }).maxBatchChars).toBe(120000);
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_MAX_BATCH_CHARS: '9999' }).maxBatchChars).toBe(9999);
  });

  test('maxFilesPerBatch default 40', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k' }).maxFilesPerBatch).toBe(40);
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_MAX_FILES_PER_BATCH: '5' }).maxFilesPerBatch).toBe(5);
  });

  test('maxPatchChars default 18000', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k' }).maxPatchChars).toBe(18000);
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_MAX_PATCH_CHARS: '2000' }).maxPatchChars).toBe(2000);
  });

  test('timeoutMs default 120000', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k' }).timeoutMs).toBe(120000);
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_TIMEOUT_MS: '30000' }).timeoutMs).toBe(30000);
  });
});

describe('loadConfig — numeric validation (negatives/zero clamped to safe defaults)', () => {
  // These inputs drive loops/batching; a non-positive value would hang
  // (splitTextByLines infinite loop) or blow up cost (one-entry-per-batch).
  test('ZAI_MAX_PATCH_CHARS=0 falls back to default (prevents infinite loop)', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_MAX_PATCH_CHARS: '0' }).maxPatchChars).toBe(18000);
  });
  test('ZAI_MAX_PATCH_CHARS=-1 falls back to default', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_MAX_PATCH_CHARS: '-1' }).maxPatchChars).toBe(18000);
  });
  test('ZAI_MAX_BATCH_CHARS=0 falls back to default (prevents batch degeneracy)', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_MAX_BATCH_CHARS: '0' }).maxBatchChars).toBe(120000);
  });
  test('ZAI_MAX_FILES_PER_BATCH=0 falls back to default', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_MAX_FILES_PER_BATCH: '0' }).maxFilesPerBatch).toBe(40);
  });
  test('ZAI_LARGE_PR_FILE_THRESHOLD=0 falls back to default', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_LARGE_PR_FILE_THRESHOLD: '0' }).largePrFileThreshold).toBe(50);
  });
  test('ZAI_TIMEOUT_MS=0 falls back to default (min 1000)', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_TIMEOUT_MS: '0' }).timeoutMs).toBe(120000);
  });
  test('ZAI_TIMEOUT_MS below 1000 clamps to 120000 default', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_TIMEOUT_MS: '500' }).timeoutMs).toBe(120000);
  });
  test('non-numeric "0x10" -> default (parseInt base 10 = 0, clamped)', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_MAX_PATCH_CHARS: '0x10' }).maxPatchChars).toBe(18000);
  });
  test('valid positive values are passed through', () => {
    const cfg = loadConfig({
      ZAI_API_KEY: 'k',
      ZAI_MAX_PATCH_CHARS: '5000',
      ZAI_MAX_BATCH_CHARS: '80000',
      ZAI_MAX_FILES_PER_BATCH: '10',
      ZAI_TIMEOUT_MS: '60000',
    });
    expect(cfg.maxPatchChars).toBe(5000);
    expect(cfg.maxBatchChars).toBe(80000);
    expect(cfg.maxFilesPerBatch).toBe(10);
    expect(cfg.timeoutMs).toBe(60000);
  });
});

describe('loadConfig — boolean fields', () => {
  const truthy = ['true', 'True', 'TRUE', '1', 'yes', 'YES', 'Yes'];
  const falsy = ['false', '0', 'no', '', 'maybe', 'random'];

  test('commandsEnabled defaults false', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k' }).commandsEnabled).toBe(false);
  });
  test.each(truthy)('commandsEnabled truthy for %s', (v) => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_COMMANDS_ENABLED: v }).commandsEnabled).toBe(true);
  });
  test.each(falsy)('commandsEnabled falsy for %s', (v) => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_COMMANDS_ENABLED: v }).commandsEnabled).toBe(false);
  });

  test('allowForkCommands defaults false', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k' }).allowForkCommands).toBe(false);
  });
  test('allowForkCommands truthy for "yes"', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_ALLOW_FORK_COMMANDS: 'yes' }).allowForkCommands).toBe(true);
  });

  test('scheduleEnabled defaults false', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k' }).scheduleEnabled).toBe(false);
  });
  test('scheduleEnabled truthy for "true"', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_SCHEDULE_ENABLED: 'true' }).scheduleEnabled).toBe(true);
  });
  test('scheduleMaxPrs defaults 10, clamped positive', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k' }).scheduleMaxPrs).toBe(10);
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_SCHEDULE_MAX_PRS: '5' }).scheduleMaxPrs).toBe(5);
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_SCHEDULE_MAX_PRS: '0' }).scheduleMaxPrs).toBe(10);
  });

  test('describeWriteBody defaults false', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k' }).describeWriteBody).toBe(false);
  });
  test('impactLabels defaults false', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k' }).impactLabels).toBe(false);
  });
  test('impactLabelMap defaults to the zai: map', () => {
    const cfg = loadConfig({ ZAI_API_KEY: 'k' });
    expect(cfg.impactLabelMap).toEqual({
      critical: 'zai:critical', high: 'zai:high', medium: 'zai:medium', low: 'zai:low',
    });
  });
  test('impactLabelMap parses a custom map and merges over defaults', () => {
    const cfg = loadConfig({
      ZAI_API_KEY: 'k',
      ZAI_IMPACT_LABEL_MAP: 'critical=severity:critical,low=lowpri',
    });
    expect(cfg.impactLabelMap.critical).toBe('severity:critical');
    expect(cfg.impactLabelMap.low).toBe('lowpri');
    // Unspecified severities keep their defaults.
    expect(cfg.impactLabelMap.high).toBe('zai:high');
    expect(cfg.impactLabelMap.medium).toBe('zai:medium');
  });
});

describe('loadConfig — authThreshold', () => {
  test('defaults to "write"', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k' }).authThreshold).toBe('write');
  });
  test.each(['admin', 'maintain', 'write', 'read', 'none'])('accepts %s', (v) => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_AUTH_THRESHOLD: v }).authThreshold).toBe(v);
  });
  test('throws on invalid value', () => {
    expect(() => loadConfig({ ZAI_API_KEY: 'k', ZAI_AUTH_THRESHOLD: 'bogus' })).toThrow(
      'ZAI_AUTH_THRESHOLD must be one of: admin, maintain, write, read, none',
    );
  });
});

describe('loadConfig — setSecret masking via options.core', () => {
  test('calls core.setSecret for apiKey and githubToken when core provided', () => {
    const calls = [];
    const core = { setSecret: (v) => calls.push(v) };
    const cfg = loadConfig(
      { ZAI_API_KEY: 'sk-secret', GITHUB_TOKEN: 'ghp_tok' },
      { core },
    );
    expect(calls).toEqual(['sk-secret', 'ghp_tok']);
    // config still returned normally
    expect(cfg.apiKey).toBe('sk-secret');
  });

  test('does NOT call setSecret when core omitted', () => {
    const cfg = loadConfig({ ZAI_API_KEY: 'sk-secret' });
    // No throw, no core required. Just ensure it returns normally.
    expect(cfg.apiKey).toBe('sk-secret');
  });
});

describe('loadConfig — combined misconfiguration rule', () => {
  test('commandsEnabled true + authThreshold none is ALLOWED (no throw)', () => {
    const cfg = loadConfig({
      ZAI_API_KEY: 'k',
      ZAI_COMMANDS_ENABLED: 'true',
      ZAI_AUTH_THRESHOLD: 'none',
    });
    expect(cfg.commandsEnabled).toBe(true);
    expect(cfg.authThreshold).toBe('none');
  });
});

describe('loadConfig — works with Map inputs', () => {
  test('reads from a Map', () => {
    const m = new Map([
      ['ZAI_API_KEY', 'k'],
      ['ZAI_MODEL', 'glm-4.6'],
    ]);
    const cfg = loadConfig(m);
    expect(cfg.apiKey).toBe('k');
    expect(cfg.model).toBe('glm-4.6');
  });

  test('treats null input values as empty (defensive)', () => {
    const cfg = loadConfig({ ZAI_API_KEY: 'k', ZAI_MODEL: null });
    expect(cfg.apiKey).toBe('k');
    expect(cfg.model).toBe('glm-5.2');
  });
});

describe('loadConfig — v2 structured-review knobs', () => {
  test('maxFindings defaults to 8', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k' }).maxFindings).toBe(8);
  });

  test('maxFindings uses a provided positive value', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_MAX_FINDINGS: '5' }).maxFindings).toBe(5);
  });

  test('maxFindings clamps to min 1 (0 → default 8)', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_MAX_FINDINGS: '0' }).maxFindings).toBe(8);
  });

  test('maxFindings clamps to min 1 (negative → default 8)', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_MAX_FINDINGS: '-3' }).maxFindings).toBe(8);
  });

  test('maxFindings caps at 50 (runaway noise guard)', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_MAX_FINDINGS: '999' }).maxFindings).toBe(50);
  });

  test('maxFindings NaN → default 8', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_MAX_FINDINGS: 'abc' }).maxFindings).toBe(8);
  });

  test('minSeverity defaults to "info"', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k' }).minSeverity).toBe('info');
  });

  test.each(['critical', 'high', 'medium', 'low', 'info'])(
    'minSeverity accepts %s (case-insensitive)',
    (v) => {
      expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_MIN_SEVERITY: v }).minSeverity).toBe(v);
      expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_MIN_SEVERITY: v.toUpperCase() }).minSeverity).toBe(v);
    },
  );

  test('minSeverity invalid → falls back to "info" + core.warning', () => {
    const warnings = [];
    const core = { setSecret: () => {}, warning: (m) => warnings.push(m) };
    const cfg = loadConfig(
      { ZAI_API_KEY: 'k', ZAI_MIN_SEVERITY: 'bogus' },
      { core },
    );
    expect(cfg.minSeverity).toBe('info');
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('ZAI_MIN_SEVERITY');
  });

  test('minSeverity invalid without core → still falls back to "info" (no throw)', () => {
    const cfg = loadConfig({ ZAI_API_KEY: 'k', ZAI_MIN_SEVERITY: 'bogus' });
    expect(cfg.minSeverity).toBe('info');
  });

  test('temperature defaults to 0.2', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k' }).temperature).toBe(0.2);
  });

  test('temperature parses a provided float', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_TEMPERATURE: '0.7' }).temperature).toBeCloseTo(0.7);
  });

  test('temperature clamps to [0, 2] — below 0 → 0', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_TEMPERATURE: '-1' }).temperature).toBe(0);
  });

  test('temperature clamps to [0, 2] — above 2 → 2', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_TEMPERATURE: '5' }).temperature).toBe(2);
  });

  test('temperature NaN → default 0.2', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_TEMPERATURE: 'abc' }).temperature).toBeCloseTo(0.2);
  });

  test('maxTokens defaults to 4096', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k' }).maxTokens).toBe(4096);
  });

  test('maxTokens uses a provided positive value', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_MAX_TOKENS: '8192' }).maxTokens).toBe(8192);
  });

  test('maxTokens clamps to min 1 (0 → default 4096)', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_MAX_TOKENS: '0' }).maxTokens).toBe(4096);
  });

  test('maxTokens clamps to min 1 (negative → default 4096)', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_MAX_TOKENS: '-5' }).maxTokens).toBe(4096);
  });

  test('maxTokens NaN → default 4096', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_MAX_TOKENS: 'xyz' }).maxTokens).toBe(4096);
  });
});

describe('scanner knobs (Phase 4)', () => {
  test('scannersEnabled defaults to true', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k' }).scannersEnabled).toBe(true);
  });

  test('scannersEnabled=true (truthy)', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_SCANNERS_ENABLED: 'true' }).scannersEnabled).toBe(true);
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_SCANNERS_ENABLED: '1' }).scannersEnabled).toBe(true);
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_SCANNERS_ENABLED: 'yes' }).scannersEnabled).toBe(true);
  });

  test('scannersEnabled=false on explicit non-truthy values', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_SCANNERS_ENABLED: 'false' }).scannersEnabled).toBe(false);
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_SCANNERS_ENABLED: '0' }).scannersEnabled).toBe(false);
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_SCANNERS_ENABLED: 'no' }).scannersEnabled).toBe(false);
  });

  test('scannersEnabled=true on empty (default true)', () => {
    // An empty input means "use the default" → true (per the action.yml
    // default and the brief).
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_SCANNERS_ENABLED: '' }).scannersEnabled).toBe(true);
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_SCANNERS_ENABLED: '   ' }).scannersEnabled).toBe(true);
  });

  test('scannersCacheDir defaults to ~/.zai-cache/scanners', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k' }).scannersCacheDir).toBe('~/.zai-cache/scanners');
  });

  test('scannersCacheDir uses a provided value', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_SCANNERS_CACHE_DIR: '/tmp/cache' }).scannersCacheDir).toBe('/tmp/cache');
  });

  test('scannersCacheDir trims whitespace', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_SCANNERS_CACHE_DIR: '  /tmp/x  ' }).scannersCacheDir).toBe('/tmp/x');
  });
});

describe('batchConcurrency + fallbackPrompt (Phase 6)', () => {
  test('batchConcurrency defaults to 3', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k' }).batchConcurrency).toBe(3);
  });

  test('batchConcurrency uses a provided value in [1, 8]', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_BATCH_CONCURRENCY: '1' }).batchConcurrency).toBe(1);
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_BATCH_CONCURRENCY: '5' }).batchConcurrency).toBe(5);
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_BATCH_CONCURRENCY: '8' }).batchConcurrency).toBe(8);
  });

  test('batchConcurrency clamps above 8 → 8', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_BATCH_CONCURRENCY: '20' }).batchConcurrency).toBe(8);
  });

  test('batchConcurrency clamps below 1 → 3 (default, treated as invalid)', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_BATCH_CONCURRENCY: '0' }).batchConcurrency).toBe(3);
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_BATCH_CONCURRENCY: '-3' }).batchConcurrency).toBe(3);
  });

  test('batchConcurrency NaN → default 3', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_BATCH_CONCURRENCY: 'abc' }).batchConcurrency).toBe(3);
  });

  test('batchConcurrency empty → default 3', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_BATCH_CONCURRENCY: '' }).batchConcurrency).toBe(3);
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_BATCH_CONCURRENCY: '   ' }).batchConcurrency).toBe(3);
  });

  test('fallbackPrompt defaults to empty string (disabled)', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k' }).fallbackPrompt).toBe('');
  });

  test('fallbackPrompt uses a provided non-empty value (trim)', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_FALLBACK_PROMPT: 'SHORT REVIEW ONLY' }).fallbackPrompt).toBe(
      'SHORT REVIEW ONLY',
    );
  });

  test('fallbackPrompt trims whitespace', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_FALLBACK_PROMPT: '  x  ' }).fallbackPrompt).toBe('x');
  });

  test('fallbackPrompt empty/whitespace → empty string (disabled)', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_FALLBACK_PROMPT: '' }).fallbackPrompt).toBe('');
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_FALLBACK_PROMPT: '   ' }).fallbackPrompt).toBe('');
  });
});

describe('commitStatus (Phase 5)', () => {
  test('defaults to true (status feedback on by default)', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k' }).commitStatus).toBe(true);
  });

  test.each(['true', '1', 'yes'])('truthy for "%s"', (v) => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_COMMIT_STATUS: v }).commitStatus).toBe(true);
  });

  test.each(['false', '0', 'no'])('falsy for "%s"', (v) => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_COMMIT_STATUS: v }).commitStatus).toBe(false);
  });

  test('empty/whitespace → true (default, matches scannersEnabled convention)', () => {
    // Empty input means "use the default" → true (per the action.yml default
    // and the brief). This mirrors scannersEnabled so direct callers without
    // the input still get status feedback.
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_COMMIT_STATUS: '' }).commitStatus).toBe(true);
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_COMMIT_STATUS: '   ' }).commitStatus).toBe(true);
  });

  test('case-insensitive: "TRUE", "Yes"', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_COMMIT_STATUS: 'TRUE' }).commitStatus).toBe(true);
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_COMMIT_STATUS: 'Yes' }).commitStatus).toBe(true);
  });
});

describe('walkthrough (Phase 7)', () => {
  test('defaults to true (walkthrough rendering on by default)', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k' }).walkthrough).toBe(true);
  });

  test.each(['true', '1', 'yes'])('truthy for "%s"', (v) => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_WALKTHROUGH: v }).walkthrough).toBe(true);
  });

  test.each(['false', '0', 'no'])('falsy for "%s"', (v) => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_WALKTHROUGH: v }).walkthrough).toBe(false);
  });

  test('empty/whitespace → true (default, matches commitStatus convention)', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_WALKTHROUGH: '' }).walkthrough).toBe(true);
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_WALKTHROUGH: '   ' }).walkthrough).toBe(true);
  });

  test('case-insensitive: "TRUE", "Yes"', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_WALKTHROUGH: 'TRUE' }).walkthrough).toBe(true);
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_WALKTHROUGH: 'Yes' }).walkthrough).toBe(true);
  });
});

describe('repoConfigEnabled (Phase 3 — .zai.yml)', () => {
  test('defaults to true (in-repo config loading on by default)', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k' }).repoConfigEnabled).toBe(true);
  });

  test.each(['true', '1', 'yes'])('truthy for "%s"', (v) => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_REPO_CONFIG_ENABLED: v }).repoConfigEnabled).toBe(true);
  });

  test.each(['false', '0', 'no'])('falsy for "%s"', (v) => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_REPO_CONFIG_ENABLED: v }).repoConfigEnabled).toBe(false);
  });

  test('empty/whitespace → true (matches commitStatus/walkthrough convention)', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_REPO_CONFIG_ENABLED: '' }).repoConfigEnabled).toBe(true);
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_REPO_CONFIG_ENABLED: '   ' }).repoConfigEnabled).toBe(true);
  });

  test('case-insensitive: "FALSE", "No"', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_REPO_CONFIG_ENABLED: 'FALSE' }).repoConfigEnabled).toBe(false);
    expect(loadConfig({ ZAI_API_KEY: 'k', ZAI_REPO_CONFIG_ENABLED: 'No' }).repoConfigEnabled).toBe(false);
  });
});
