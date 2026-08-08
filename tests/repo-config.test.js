/**
 * Tests for src/lib/repo-config.js — loading + validating .zai.yml.
 *
 * The .zai.yml is attacker-controllable in fork PRs, so the parser must be
 * tolerant (never throw) and the validator must drop unknown/invalid keys. The
 * merge is the security-critical seam: action inputs ALWAYS win on cost/security
 * knobs; the repo can only NARROW behavior.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  parseZaiYml,
  validateRepoConfig,
  mergeRepoConfig,
  loadRepoConfig,
} from '../src/lib/repo-config.js';

/* ------------------------------------------------------------------ *
 * parseZaiYml
 * ------------------------------------------------------------------ */

describe('parseZaiYml — full valid document', () => {
  it('parses a complete, well-formed .zai.yml', () => {
    const text = `
# Top-level comment
reviews:
  profile: chill
  max_findings: 8
  path_instructions:
    - path: "src/auth/**"
      instructions: "Be strict on auth."
    - path: "src/db/**"
      instructions: "Check SQL injection."
  path_filters:
    - "!dist/**"
    - "!build/**"
  tone_instructions: "Be terse."
  language: en-US
scanners:
  gitleaks: true
  ast_grep: false
`;
    const parsed = parseZaiYml(text);
    expect(parsed).toEqual({
      reviews: {
        profile: 'chill',
        max_findings: 8,
        path_instructions: [
          { path: 'src/auth/**', instructions: 'Be strict on auth.' },
          { path: 'src/db/**', instructions: 'Check SQL injection.' },
        ],
        path_filters: ['!dist/**', '!build/**'],
        tone_instructions: 'Be terse.',
        language: 'en-US',
      },
      scanners: {
        gitleaks: true,
        ast_grep: false,
      },
    });
  });
});

describe('parseZaiYml — scalar value forms', () => {
  it('parses quoted string values', () => {
    const parsed = parseZaiYml('reviews:\n  profile: "chill"\n  tone_instructions: \'be nice\'\n');
    expect(parsed.reviews.profile).toBe('chill');
    expect(parsed.reviews.tone_instructions).toBe('be nice');
  });

  it('parses unquoted string values', () => {
    const parsed = parseZaiYml('reviews:\n  language: en-US\n');
    expect(parsed.reviews.language).toBe('en-US');
  });

  it('parses numeric values as numbers', () => {
    const parsed = parseZaiYml('reviews:\n  max_findings: 12\n');
    expect(parsed.reviews.max_findings).toBe(12);
  });

  it('parses boolean values as booleans', () => {
    const parsed = parseZaiYml('scanners:\n  gitleaks: true\n  ast_grep: false\n');
    expect(parsed.scanners.gitleaks).toBe(true);
    expect(parsed.scanners.ast_grep).toBe(false);
  });
});

describe('parseZaiYml — comments', () => {
  it('strips inline comments', () => {
    const text = 'reviews:\n  profile: chill # the relaxed profile\n';
    expect(parseZaiYml(text).reviews.profile).toBe('chill');
  });

  it('strips full-line comments', () => {
    const text = '# a comment\nreviews:\n# another\n  profile: chill\n';
    expect(parseZaiYml(text).reviews.profile).toBe('chill');
  });

  it('preserves # inside quoted strings', () => {
    const text = 'reviews:\n  tone_instructions: "use # for headers"\n';
    expect(parseZaiYml(text).reviews.tone_instructions).toBe('use # for headers');
  });
});

describe('parseZaiYml — arrays', () => {
  it('parses arrays of strings', () => {
    const text = 'reviews:\n  path_filters:\n    - "!dist/**"\n    - "!build/**"\n';
    expect(parseZaiYml(text).reviews.path_filters).toEqual(['!dist/**', '!build/**']);
  });

  it('parses arrays of unquoted strings', () => {
    const text = 'reviews:\n  path_filters:\n    - !dist/**\n    - !build/**\n';
    expect(parseZaiYml(text).reviews.path_filters).toEqual(['!dist/**', '!build/**']);
  });

  it('parses arrays of objects', () => {
    const text = `reviews:
  path_instructions:
    - path: "src/a"
      instructions: "rule a"
    - path: "src/b"
      instructions: "rule b"
`;
    expect(parseZaiYml(text).reviews.path_instructions).toEqual([
      { path: 'src/a', instructions: 'rule a' },
      { path: 'src/b', instructions: 'rule b' },
    ]);
  });
});

describe('parseZaiYml — tolerance', () => {
  it('returns {} for empty input', () => {
    expect(parseZaiYml('')).toEqual({});
    expect(parseZaiYml('   \n\n  ')).toEqual({});
  });

  it('returns {} for only comments', () => {
    expect(parseZaiYml('# just a comment\n# another\n')).toEqual({});
  });

  it('skips unrecognized top-level keys', () => {
    const text = 'unknown_key: value\nreviews:\n  profile: chill\n';
    const parsed = parseZaiYml(text);
    expect(parsed.reviews.profile).toBe('chill');
    expect(parsed).not.toHaveProperty('unknown_key');
  });

  it('skips unrecognized nested keys', () => {
    const text = 'reviews:\n  profile: chill\n  mystery: value\n';
    const parsed = parseZaiYml(text);
    expect(parsed.reviews.profile).toBe('chill');
    expect(parsed.reviews).not.toHaveProperty('mystery');
  });

  it('is tolerant of trailing whitespace', () => {
    const text = 'reviews:   \n  profile: chill   \n';
    expect(parseZaiYml(text).reviews.profile).toBe('chill');
  });

  it('does not throw on deeply malformed input', () => {
    const texts = [
      ':::not yaml at all:::',
      'reviews: [1, 2, 3',
      '- - -\n  : :',
      'reviews\n  profile chill',
      '!!!@#$%^&*()',
    ];
    for (const t of texts) {
      expect(() => parseZaiYml(t)).not.toThrow();
    }
  });
});

/* ------------------------------------------------------------------ *
 * validateRepoConfig
 * ------------------------------------------------------------------ */

describe('validateRepoConfig — profile', () => {
  it('accepts chill and assertive', () => {
    expect(validateRepoConfig({ reviews: { profile: 'chill' } }).reviews.profile).toBe('chill');
    expect(validateRepoConfig({ reviews: { profile: 'assertive' } }).reviews.profile).toBe('assertive');
  });
  it('drops invalid profile values', () => {
    const out = validateRepoConfig({ reviews: { profile: 'mean' } });
    // profile dropped → reviews sub-object has nothing valid → omitted entirely
    expect(out).not.toHaveProperty('reviews');
  });
});

describe('validateRepoConfig — max_findings', () => {
  it('accepts a positive integer', () => {
    expect(validateRepoConfig({ reviews: { max_findings: 5 } }).reviews.max_findings).toBe(5);
  });
  it('drops zero, negative, non-integer, non-number', () => {
    for (const v of [0, -1, 1.5, '8', null, true, NaN]) {
      const out = validateRepoConfig({ reviews: { max_findings: v } });
      expect(out).not.toHaveProperty('reviews');
    }
  });
});

describe('validateRepoConfig — path_instructions', () => {
  it('accepts well-formed entries', () => {
    const out = validateRepoConfig({
      reviews: {
        path_instructions: [
          { path: 'src/**', instructions: 'be strict' },
          { path: 'test/**', instructions: 'be lax' },
        ],
      },
    });
    expect(out.reviews.path_instructions).toHaveLength(2);
  });
  it('filters out entries missing required string fields', () => {
    const out = validateRepoConfig({
      reviews: {
        path_instructions: [
          { path: 'src/**', instructions: 'ok' },
          { path: 'src/**' }, // missing instructions
          { instructions: 'no path' }, // missing path
          { path: 42, instructions: 'bad path type' },
          null,
          'not-an-object',
        ],
      },
    });
    expect(out.reviews.path_instructions).toEqual([
      { path: 'src/**', instructions: 'ok' },
    ]);
  });
  it('drops path_instructions entirely when not an array', () => {
    const out = validateRepoConfig({ reviews: { path_instructions: 'not array' } });
    expect(out).not.toHaveProperty('reviews');
  });
  it('truncates instructions longer than 1000 chars', () => {
    const long = 'x'.repeat(2000);
    const out = validateRepoConfig({
      reviews: { path_instructions: [{ path: 'src/**', instructions: long }] },
    });
    expect(out.reviews.path_instructions[0].instructions.length).toBe(1000);
  });
  it('truncates path longer than 500 chars', () => {
    const longPath = 'p'.repeat(1000);
    const out = validateRepoConfig({
      reviews: { path_instructions: [{ path: longPath, instructions: 'ok' }] },
    });
    expect(out.reviews.path_instructions[0].path.length).toBe(500);
  });
  it('caps total entries to 50', () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({
      path: `p${i}`,
      instructions: `i${i}`,
    }));
    const out = validateRepoConfig({ reviews: { path_instructions: entries } });
    expect(out.reviews.path_instructions).toHaveLength(50);
  });
});

describe('validateRepoConfig — path_filters', () => {
  it('accepts an array of strings', () => {
    const out = validateRepoConfig({
      reviews: { path_filters: ['!dist/**', '!build/**'] },
    });
    expect(out.reviews.path_filters).toEqual(['!dist/**', '!build/**']);
  });
  it('drops non-string entries', () => {
    const out = validateRepoConfig({
      reviews: { path_filters: ['!dist/**', 42, null, '', '!build/**'] },
    });
    expect(out.reviews.path_filters).toEqual(['!dist/**', '!build/**']);
  });
  it('drops path_filters when not an array', () => {
    const out = validateRepoConfig({ reviews: { path_filters: '!dist/**' } });
    expect(out).not.toHaveProperty('reviews');
  });
});

describe('validateRepoConfig — tone_instructions', () => {
  it('accepts a string', () => {
    expect(validateRepoConfig({ reviews: { tone_instructions: 'be terse' } }).reviews.tone_instructions).toBe('be terse');
  });
  it('truncates strings longer than 500 chars', () => {
    const long = 'x'.repeat(600);
    const out = validateRepoConfig({ reviews: { tone_instructions: long } });
    expect(out.reviews.tone_instructions.length).toBe(500);
  });
  it('drops non-string values', () => {
    const out = validateRepoConfig({ reviews: { tone_instructions: 42 } });
    expect(out).not.toHaveProperty('reviews');
  });
});

describe('validateRepoConfig — language', () => {
  it('accepts a string <= 20 chars', () => {
    expect(validateRepoConfig({ reviews: { language: 'en-US' } }).reviews.language).toBe('en-US');
  });
  it('truncates strings longer than 20 chars', () => {
    const out = validateRepoConfig({ reviews: { language: 'x'.repeat(30) } });
    expect(out.reviews.language.length).toBe(20);
  });
  it('drops non-string values', () => {
    const out = validateRepoConfig({ reviews: { language: 42 } });
    expect(out).not.toHaveProperty('reviews');
  });
});

describe('validateRepoConfig — scanners', () => {
  it('accepts boolean gitleaks/ast_grep', () => {
    const out = validateRepoConfig({ scanners: { gitleaks: true, ast_grep: false } });
    expect(out.scanners).toEqual({ gitleaks: true, ast_grep: false });
  });
  it('drops non-boolean scanner values', () => {
    const out = validateRepoConfig({ scanners: { gitleaks: 'true', ast_grep: 0 } });
    // All scanner values invalid → scanners sub-object omitted entirely.
    expect(out).not.toHaveProperty('scanners');
  });
  it('drops unknown scanner keys', () => {
    const out = validateRepoConfig({ scanners: { gitleaks: true, mystery: true } });
    expect(out.scanners).toEqual({ gitleaks: true });
  });
});

describe('validateRepoConfig — unknown keys + edge cases', () => {
  it('drops ALL unknown top-level keys', () => {
    const out = validateRepoConfig({
      reviews: { profile: 'chill' },
      scanners: { gitleaks: true },
      mystery_top: { nested: true },
      another: 'value',
    });
    expect(Object.keys(out).sort()).toEqual(['reviews', 'scanners']);
    expect(out).not.toHaveProperty('mystery_top');
    expect(out).not.toHaveProperty('another');
  });
  it('returns {} for non-object input', () => {
    expect(validateRepoConfig(null)).toEqual({});
    expect(validateRepoConfig('string')).toEqual({});
    expect(validateRepoConfig([])).toEqual({});
    expect(validateRepoConfig(42)).toEqual({});
  });
  it('returns {} for empty object', () => {
    expect(validateRepoConfig({})).toEqual({});
  });
  it('omits reviews/scanners entirely when empty', () => {
    const out = validateRepoConfig({ reviews: {}, scanners: {} });
    // Empty reviews/scanners should not appear in output.
    expect(out).toEqual({});
  });
});

/* ------------------------------------------------------------------ *
 * mergeRepoConfig
 * ------------------------------------------------------------------ */

describe('mergeRepoConfig — maxFindings', () => {
  it('uses repo value when lower than action', () => {
    const merged = mergeRepoConfig(
      { maxFindings: 10 },
      { reviews: { max_findings: 5 } },
    );
    expect(merged.maxFindings).toBe(5);
  });
  it('uses action value when repo is higher (repo cannot raise)', () => {
    const merged = mergeRepoConfig(
      { maxFindings: 10 },
      { reviews: { max_findings: 50 } },
    );
    expect(merged.maxFindings).toBe(10);
  });
  it('uses action value when repo has no max_findings', () => {
    const merged = mergeRepoConfig({ maxFindings: 10 }, {});
    expect(merged.maxFindings).toBe(10);
  });
});

describe('mergeRepoConfig — pathInstructions (additive)', () => {
  it('passes through repo path_instructions', () => {
    const merged = mergeRepoConfig(
      { maxFindings: 8 },
      { reviews: { path_instructions: [{ path: 'src/**', instructions: 'strict' }] } },
    );
    expect(merged.pathInstructions).toEqual([
      { path: 'src/**', instructions: 'strict' },
    ]);
  });
  it('defaults to undefined/empty when repo has none', () => {
    const merged = mergeRepoConfig({ maxFindings: 8 }, {});
    expect(merged.pathInstructions).toEqual([]);
  });
});

describe('mergeRepoConfig — toneInstructions (additive)', () => {
  it('passes through repo tone_instructions', () => {
    const merged = mergeRepoConfig(
      { maxFindings: 8 },
      { reviews: { tone_instructions: 'be terse' } },
    );
    expect(merged.toneInstructions).toBe('be terse');
  });
  it('defaults to empty string when repo has none', () => {
    const merged = mergeRepoConfig({ maxFindings: 8 }, {});
    expect(merged.toneInstructions).toBe('');
  });
});

describe('mergeRepoConfig — pathFilters (union)', () => {
  it('unions repo path_filters with action excludePatterns (repo can add MORE)', () => {
    const merged = mergeRepoConfig(
      { excludePatterns: ['*.lock'] },
      { reviews: { path_filters: ['!dist/**', '!build/**'] } },
    );
    expect(merged.excludePatterns.sort()).toEqual(['!build/**', '!dist/**', '*.lock']);
  });
  it('keeps action excludePatterns when repo has none', () => {
    const merged = mergeRepoConfig({ excludePatterns: ['*.lock'] }, {});
    expect(merged.excludePatterns).toEqual(['*.lock']);
  });
  it('repo can NEVER reduce the action excludePatterns', () => {
    // Even an empty repo path_filters must not remove the action patterns.
    const merged = mergeRepoConfig(
      { excludePatterns: ['*.lock', 'dist/**'] },
      { reviews: { path_filters: [] } },
    );
    expect(merged.excludePatterns).toEqual(['*.lock', 'dist/**']);
  });
});

describe('mergeRepoConfig — scanners (can only DISABLE)', () => {
  it('repo can disable a scanner the action enabled', () => {
    const merged = mergeRepoConfig(
      { scannersEnabled: true },
      { scanners: { gitleaks: false } },
    );
    expect(merged.scanners.gitleaks).toBe(false);
  });
  it('repo cannot enable a scanner the action disabled', () => {
    const merged = mergeRepoConfig(
      { scannersEnabled: false },
      { scanners: { gitleaks: true } },
    );
    // Action master switch OFF → all scanners stay OFF regardless of repo.
    expect(merged.scannersEnabled).toBe(false);
    expect(merged.scanners.gitleaks).toBe(false);
    expect(merged.scanners.ast_grep).toBe(false);
  });
  it('master switch OFF forces ALL per-scanner flags false (no repo config)', () => {
    // When the action turns scanners off entirely, the per-scanner booleans
    // must also be false — they cannot default to true.
    const merged = mergeRepoConfig({ scannersEnabled: false }, {});
    expect(merged.scannersEnabled).toBe(false);
    expect(merged.scanners.gitleaks).toBe(false);
    expect(merged.scanners.ast_grep).toBe(false);
  });
  it('master switch OFF stays false even when repo explicitly enables both', () => {
    const merged = mergeRepoConfig(
      { scannersEnabled: false },
      { scanners: { gitleaks: true, ast_grep: true } },
    );
    expect(merged.scanners.gitleaks).toBe(false);
    expect(merged.scanners.ast_grep).toBe(false);
  });
  it('repo true keeps a scanner on (when action enabled)', () => {
    const merged = mergeRepoConfig(
      { scannersEnabled: true },
      { scanners: { gitleaks: true } },
    );
    expect(merged.scanners.gitleaks).toBe(true);
  });
  it('repo undefined keeps the action default (enabled)', () => {
    const merged = mergeRepoConfig(
      { scannersEnabled: true },
      {},
    );
    expect(merged.scanners.gitleaks).not.toBe(false);
  });
});

describe('mergeRepoConfig — minSeverity (action wins)', () => {
  it('action input wins on minSeverity', () => {
    const merged = mergeRepoConfig(
      { minSeverity: 'high' },
      { reviews: { min_severity: 'low' } }, // note: not even in the validated schema
    );
    expect(merged.minSeverity).toBe('high');
  });
});

/* ------------------------------------------------------------------ *
 * loadRepoConfig
 * ------------------------------------------------------------------ */

/** Build a fake octokit whose repos.getContent returns base64 `content`. */
function makeOctokitWithContent(content, opts = {}) {
  const encoded = Buffer.from(content, 'utf8').toString('base64');
  return {
    rest: {
      repos: {
        async getContent(params) {
          if (opts.throw404) {
            const err = new Error('Not Found');
            err.status = 404;
            throw err;
          }
          if (opts.throw500) {
            const err = new Error('Server Error');
            err.status = 500;
            throw err;
          }
          // Record the call for assertions.
          getContent.calls.push(params);
          if (opts.returnRawString) return { data: content };
          return {
            data: {
              content: encoded,
              encoding: 'base64',
            },
          };
        },
      },
    },
  };
}
const getContent = { calls: [] };

/** A minimal context with repo + payload.pull_request.head.sha. */
function makeContext(headSha = 'deadbeef') {
  return {
    repo: { owner: 'owner', repo: 'repo' },
    payload: { pull_request: { head: { sha: headSha } } },
  };
}

/** A fake core that records warnings. */
function makeCore() {
  const warnings = [];
  return {
    core: {
      warning: vi.fn((msg) => warnings.push(msg)),
      info: vi.fn(),
    },
    warnings,
  };
}

describe('loadRepoConfig — happy path', () => {
  it('fetches, decodes, parses, and validates', async () => {
    getContent.calls.length = 0;
    const yaml = `
reviews:
  profile: chill
  path_instructions:
    - path: "src/**"
      instructions: "be strict"
scanners:
  gitleaks: false
`;
    const octokit = makeOctokitWithContent(yaml);
    const { core } = makeCore();
    const out = await loadRepoConfig(
      { octokit, context: makeContext('sha-1') },
      { core },
    );
    // Fetch used the head SHA as ref.
    expect(getContent.calls[0]).toMatchObject({
      owner: 'owner',
      repo: 'repo',
      path: '.zai.yml',
      ref: 'sha-1',
    });
    expect(out.reviews.profile).toBe('chill');
    expect(out.reviews.path_instructions).toEqual([
      { path: 'src/**', instructions: 'be strict' },
    ]);
    expect(out.scanners.gitleaks).toBe(false);
  });

  it('accepts an explicit headSha and path override', async () => {
    getContent.calls.length = 0;
    const octokit = makeOctokitWithContent('reviews:\n  profile: assertive\n');
    const { core } = makeCore();
    const out = await loadRepoConfig(
      { octokit, context: makeContext(), headSha: 'explicit-sha', path: '.zai.yaml' },
      { core },
    );
    expect(getContent.calls[0]).toMatchObject({
      ref: 'explicit-sha',
      path: '.zai.yaml',
    });
    expect(out.reviews.profile).toBe('assertive');
  });
});

describe('loadRepoConfig — error paths return {}', () => {
  it('returns {} on 404 and warns', async () => {
    const octokit = makeOctokitWithContent('', { throw404: true });
    const { core, warnings } = makeCore();
    const out = await loadRepoConfig(
      { octokit, context: makeContext() },
      { core },
    );
    expect(out).toEqual({});
    expect(core.warning).toHaveBeenCalled();
    expect(warnings[0]).toMatch(/\.zai\.yml/i);
  });

  it('returns {} on malformed YAML and warns', async () => {
    const octokit = makeOctokitWithContent(':::not yaml:::');
    const { core } = makeCore();
    const out = await loadRepoConfig(
      { octokit, context: makeContext() },
      { core },
    );
    expect(out).toEqual({});
    expect(core.warning).toHaveBeenCalled();
  });

  it('returns {} on a 500 error and warns (never throws)', async () => {
    const octokit = makeOctokitWithContent('', { throw500: true });
    const { core } = makeCore();
    const out = await loadRepoConfig(
      { octokit, context: makeContext() },
      { core },
    );
    expect(out).toEqual({});
    expect(core.warning).toHaveBeenCalled();
  });

  it('returns {} when headSha cannot be resolved', async () => {
    getContent.calls.length = 0;
    const octokit = makeOctokitWithContent('reviews:\n  profile: chill\n');
    const { core } = makeCore();
    // No headSha in opts AND context.payload.pull_request.head.sha missing.
    const out = await loadRepoConfig(
      { octokit, context: { repo: { owner: 'o', repo: 'r' }, payload: {} } },
      { core },
    );
    expect(out).toEqual({});
    expect(getContent.calls).toHaveLength(0); // never fetched
  });
});

describe('loadRepoConfig — oversized content', () => {
  it('returns {} and warns when content exceeds the size cap', async () => {
    // Build content larger than the cap (default 65536 chars).
    const huge = '# ' + 'x'.repeat(70_000);
    const octokit = makeOctokitWithContent(huge);
    const { core } = makeCore();
    const out = await loadRepoConfig(
      { octokit, context: makeContext() },
      { core },
    );
    expect(out).toEqual({});
    expect(core.warning).toHaveBeenCalled();
  });
});

describe('loadRepoConfig — no deps.core', () => {
  it('still returns {} on error (does not throw) when core is absent', async () => {
    const octokit = makeOctokitWithContent('', { throw404: true });
    await expect(
      loadRepoConfig({ octokit, context: makeContext() }, {}),
    ).resolves.toEqual({});
  });
});
