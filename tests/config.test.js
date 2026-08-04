import { describe, test, expect } from 'vitest';
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
  test('maxDiffChars: parseInt base 10, NaN->0', () => {
    expect(loadConfig({ ZAI_API_KEY: 'k' }).maxDiffChars).toBe(0);
    expect(loadConfig({ ZAI_API_KEY: 'k', MAX_DIFF_CHARS: '50000' }).maxDiffChars).toBe(50000);
    expect(loadConfig({ ZAI_API_KEY: 'k', MAX_DIFF_CHARS: 'abc' }).maxDiffChars).toBe(0);
    expect(loadConfig({ ZAI_API_KEY: 'k', MAX_DIFF_CHARS: '12.9' }).maxDiffChars).toBe(12);
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
