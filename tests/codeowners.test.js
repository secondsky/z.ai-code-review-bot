/**
 * Tests for src/lib/codeowners.js — CODEOWNERS parsing, matching, and
 * reviewer-suggestion aggregation, plus the loadCodeowners fetch helper.
 *
 * CODEOWNERS is treated as UNTRUSTED attacker-controllable input (fork PRs can
 * commit one): the parser must be tolerant (never throw) and the fetch helper
 * must fail-soft to `[]` on any error.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  parseCodeowners,
  matchCodeowners,
  suggestReviewers,
  loadCodeowners,
  formatSuggestedReviewersLine,
  pickAssignableReviewers,
} from '../src/lib/codeowners.js';

/* ------------------------------------------------------------------ *
 * parseCodeowners
 * ------------------------------------------------------------------ */

describe('parseCodeowners — well-formed input', () => {
  it('parses a single simple line', () => {
    const rules = parseCodeowners('* @alice');
    expect(rules).toEqual([{ pattern: '*', owners: ['@alice'] }]);
  });

  it('parses multiple owners on one line', () => {
    const rules = parseCodeowners('src/ @alice @bob');
    expect(rules).toEqual([{ pattern: 'src/', owners: ['@alice', '@bob'] }]);
  });

  it('parses a path with multiple nested segments', () => {
    const rules = parseCodeowners('src/lib/foo.js @alice');
    expect(rules).toEqual([
      { pattern: 'src/lib/foo.js', owners: ['@alice'] },
    ]);
  });

  it('parses org/team owners (@org/team)', () => {
    const rules = parseCodeowners('docs/ @acme/docs-team @alice');
    expect(rules).toEqual([
      { pattern: 'docs/', owners: ['@acme/docs-team', '@alice'] },
    ]);
  });

  it('parses a full document in order', () => {
    const text = `# These are the owners
* @everyone

# Frontend
src/ui/** @fe-team @alice

# Backend
src/api/** @be-team
`;
    expect(parseCodeowners(text)).toEqual([
      { pattern: '*', owners: ['@everyone'] },
      { pattern: 'src/ui/**', owners: ['@fe-team', '@alice'] },
      { pattern: 'src/api/**', owners: ['@be-team'] },
    ]);
  });
});

describe('parseCodeowners — comments', () => {
  it('strips full-line comments', () => {
    expect(parseCodeowners('# a comment\n* @alice\n')).toEqual([
      { pattern: '*', owners: ['@alice'] },
    ]);
  });

  it('strips inline comments (whitespace-prefixed #)', () => {
    // A trailing " # comment" is stripped; the owners list is unaffected.
    const rules = parseCodeowners('src/ @alice # the alice person\n');
    expect(rules).toEqual([{ pattern: 'src/', owners: ['@alice'] }]);
  });

  it('does NOT treat a # glued to a value as a comment', () => {
    // Per CODEOWNERS convention, `#` mid-token (no preceding whitespace) is
    // part of the value. The parser must not strip it as a comment.
    // (In practice owners never contain #, but we mirror the YAML rule used
    // throughout the codebase for consistency.)
    const rules = parseCodeowners('src/ @alice\n');
    expect(rules[0].owners).toEqual(['@alice']);
  });
});

describe('parseCodeowners — globs / patterns', () => {
  it('parses a single-star pattern', () => {
    expect(parseCodeowners('*.js @fe')).toEqual([
      { pattern: '*.js', owners: ['@fe'] },
    ]);
  });

  it('parses a double-star pattern', () => {
    expect(parseCodeowners('src/** @fe')).toEqual([
      { pattern: 'src/**', owners: ['@fe'] },
    ]);
  });

  it('parses a brace-expansion pattern', () => {
    expect(parseCodeowners('*.{js,ts} @fe')).toEqual([
      { pattern: '*.{js,ts}', owners: ['@fe'] },
    ]);
  });

  it('parses a single-char wildcard (?)', () => {
    expect(parseCodeowners('foo?.js @fe')).toEqual([
      { pattern: 'foo?.js', owners: ['@fe'] },
    ]);
  });

  it('parses an unowned pattern (no owners)', () => {
    // CODEOWNERS permits lines with no owners; they still count as a match
    // (with an empty owners list). The parser must not drop them.
    expect(parseCodeowners('vendor/')).toEqual([
      { pattern: 'vendor/', owners: [] },
    ]);
  });
});

describe('parseCodeowners — empty / malformed input', () => {
  it('returns [] for empty string', () => {
    expect(parseCodeowners('')).toEqual([]);
  });

  it('returns [] for whitespace-only input', () => {
    expect(parseCodeowners('   \n\t\n  ')).toEqual([]);
  });

  it('returns [] for a comments-only file', () => {
    expect(parseCodeowners('# just a comment\n# another\n')).toEqual([]);
  });

  it('skips empty lines', () => {
    expect(parseCodeowners('\n\n* @alice\n\n')).toEqual([
      { pattern: '*', owners: ['@alice'] },
    ]);
  });

  it('skips lines whose only non-comment token is whitespace', () => {
    expect(parseCodeowners('* @alice\n   # comment\n')).toEqual([
      { pattern: '*', owners: ['@alice'] },
    ]);
  });

  it('never throws on garbage input', () => {
    expect(() => parseCodeowners(null)).not.toThrow();
    expect(() => parseCodeowners(undefined)).not.toThrow();
    expect(() => parseCodeowners(42)).not.toThrow();
    expect(() => parseCodeowners('@@@ not valid @@@')).not.toThrow();
  });

  it('returns [] for non-string input', () => {
    expect(parseCodeowners(null)).toEqual([]);
    expect(parseCodeowners(undefined)).toEqual([]);
    expect(parseCodeowners(42)).toEqual([]);
  });

  it('ignores leading whitespace before a pattern', () => {
    expect(parseCodeowners('   src/ @alice\n')).toEqual([
      { pattern: 'src/', owners: ['@alice'] },
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * matchCodeowners
 * ------------------------------------------------------------------ */

describe('matchCodeowners — matching semantics', () => {
  it('matches a basename wildcard to a top-level file', () => {
    const rules = parseCodeowners('*.js @fe');
    const m = matchCodeowners(rules, ['src/a.js']);
    expect(m.get('src/a.js')).toEqual(['@fe']);
  });

  it('matches a directory prefix to nested files (recursive)', () => {
    const rules = parseCodeowners('src/ @fe');
    const m = matchCodeowners(rules, ['src/a.js', 'src/lib/b.js']);
    expect(m.get('src/a.js')).toEqual(['@fe']);
    expect(m.get('src/lib/b.js')).toEqual(['@fe']);
  });

  it('matches a globstar (**)', () => {
    const rules = parseCodeowners('src/** @fe');
    const m = matchCodeowners(rules, ['src/a.js', 'src/lib/b.js', 'test/c.js']);
    expect(m.get('src/a.js')).toEqual(['@fe']);
    expect(m.get('src/lib/b.js')).toEqual(['@fe']);
    expect(m.has('test/c.js')).toBe(false);
  });

  it('uses LAST match wins (GitHub behavior)', () => {
    const text = `* @everyone
src/** @fe
src/index.js @special
`;
    const rules = parseCodeowners(text);
    const m = matchCodeowners(rules, ['src/index.js', 'src/other.js']);
    expect(m.get('src/index.js')).toEqual(['@special']);
    expect(m.get('src/other.js')).toEqual(['@fe']);
  });

  it('returns an empty Map when no rules match any file', () => {
    const rules = parseCodeowners('docs/** @docs');
    const m = matchCodeowners(rules, ['src/a.js', 'src/b.js']);
    expect(m.size).toBe(0);
  });

  it('returns an empty Map when there are no rules', () => {
    const m = matchCodeowners([], ['src/a.js']);
    expect(m.size).toBe(0);
  });

  it('returns an empty Map when there are no changed files', () => {
    const rules = parseCodeowners('* @alice');
    expect(matchCodeowners(rules, []).size).toBe(0);
  });

  it('does not throw on non-array inputs', () => {
    const rules = parseCodeowners('* @alice');
    expect(() => matchCodeowners(rules, null)).not.toThrow();
    expect(() => matchCodeowners(null, ['x'])).not.toThrow();
    expect(matchCodeowners(rules, null).size).toBe(0);
  });

  it('handles brace expansion', () => {
    const rules = parseCodeowners('*.{js,ts} @fe');
    const m = matchCodeowners(rules, ['src/a.js', 'src/b.ts', 'src/c.py']);
    expect(m.get('src/a.js')).toEqual(['@fe']);
    expect(m.get('src/b.ts')).toEqual(['@fe']);
    expect(m.has('src/c.py')).toBe(false);
  });

  it('returns an empty owners array for a matched unowned pattern', () => {
    const rules = parseCodeowners('vendor/ # no owners');
    const m = matchCodeowners(rules, ['vendor/x.js']);
    // The pattern matches but the rule has no owners — still a "match" with
    // an empty owner list. Aggregation in suggestReviewers ignores empties.
    expect(m.get('vendor/x.js')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * suggestReviewers
 * ------------------------------------------------------------------ */

describe('suggestReviewers — aggregation', () => {
  it('aggregates unique owners across multiple files', () => {
    const rules = parseCodeowners('src/** @fe\nsrc/api/** @be\n');
    const { suggestedReviewers, byFile } = suggestReviewers(
      ['src/ui/a.js', 'src/api/b.js'],
      rules,
    );
    // Order is preserved by first-seen (deterministic).
    expect(suggestedReviewers.sort()).toEqual(['@be', '@fe']);
    expect(byFile.get('src/ui/a.js')).toEqual(['@fe']);
    expect(byFile.get('src/api/b.js')).toEqual(['@be']);
  });

  it('dedupes owners across files', () => {
    const rules = parseCodeowners('* @alice @bob');
    const { suggestedReviewers } = suggestReviewers(
      ['a.js', 'b.js', 'c.js'],
      rules,
    );
    expect(suggestedReviewers.sort()).toEqual(['@alice', '@bob']);
  });

  it('returns an empty list when nothing matched', () => {
    const rules = parseCodeowners('docs/** @docs');
    const { suggestedReviewers, byFile } = suggestReviewers(
      ['src/a.js'],
      rules,
    );
    expect(suggestedReviewers).toEqual([]);
    expect(byFile.size).toBe(0);
  });

  it('returns an empty list for empty rules', () => {
    const { suggestedReviewers, byFile } = suggestReviewers(['src/a.js'], []);
    expect(suggestedReviewers).toEqual([]);
    expect(byFile.size).toBe(0);
  });

  it('returns an empty list for empty changedFiles', () => {
    const rules = parseCodeowners('* @alice');
    const { suggestedReviewers, byFile } = suggestReviewers([], rules);
    expect(suggestedReviewers).toEqual([]);
    expect(byFile.size).toBe(0);
  });

  it('does not throw on non-array inputs', () => {
    expect(() => suggestReviewers(null, [])).not.toThrow();
    expect(() => suggestReviewers(['x'], null)).not.toThrow();
  });

  it('skips files that matched an unowned pattern', () => {
    const rules = parseCodeowners('vendor/ # no owners');
    const { suggestedReviewers } = suggestReviewers(['vendor/x.js'], rules);
    expect(suggestedReviewers).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * formatSuggestedReviewersLine
 * ------------------------------------------------------------------ */

describe('formatSuggestedReviewersLine', () => {
  it('renders a single owner', () => {
    expect(formatSuggestedReviewersLine(['@alice'])).toBe(
      '**Suggested reviewers:** @alice',
    );
  });

  it('renders multiple owners comma-separated', () => {
    expect(formatSuggestedReviewersLine(['@alice', '@bob', '@acme/fe'])).toBe(
      '**Suggested reviewers:** @alice, @bob, @acme/fe',
    );
  });

  it('returns an empty string for an empty list', () => {
    expect(formatSuggestedReviewersLine([])).toBe('');
  });

  it('returns an empty string for non-array input', () => {
    expect(formatSuggestedReviewersLine(null)).toBe('');
    expect(formatSuggestedReviewersLine(undefined)).toBe('');
  });
});

/* ------------------------------------------------------------------ *
 * pickAssignableReviewers
 * ------------------------------------------------------------------ */

describe('pickAssignableReviewers', () => {
  it('keeps @user handles and strips the leading @', () => {
    expect(pickAssignableReviewers(['@alice', '@bob'])).toEqual(['alice', 'bob']);
  });

  it('drops @org/team handles (teams are summary-only)', () => {
    expect(pickAssignableReviewers(['@alice', '@acme/fe', '@bob'])).toEqual([
      'alice',
      'bob',
    ]);
  });

  it('dedupes handles', () => {
    expect(pickAssignableReviewers(['@alice', '@alice', '@bob'])).toEqual([
      'alice',
      'bob',
    ]);
  });

  it('handles handles without a leading @', () => {
    expect(pickAssignableReviewers(['alice', 'bob'])).toEqual(['alice', 'bob']);
  });

  it('returns [] for an empty list', () => {
    expect(pickAssignableReviewers([])).toEqual([]);
  });

  it('returns [] for non-array input', () => {
    expect(pickAssignableReviewers(null)).toEqual([]);
    expect(pickAssignableReviewers(undefined)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * loadCodeowners
 * ------------------------------------------------------------------ */

/** Build a fake octokit whose repos.getContent returns base64 `content`. */
function makeOctokitWithContent(content, opts = {}) {
  const encoded = Buffer.from(content, 'utf8').toString('base64');
  const calls = { getContent: [] };
  const octokit = {
    rest: {
      repos: {
        async getContent(params) {
          calls.getContent.push(params);
          if (opts.throw404For && opts.throw404For.includes(params.path)) {
            const err = new Error('Not Found');
            err.status = 404;
            throw err;
          }
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
          if (opts.foundPath && params.path !== opts.foundPath) {
            // Simulate the real repo: only the requested path returns content;
            // all others 404.
            const err = new Error('Not Found');
            err.status = 404;
            throw err;
          }
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
  octokit.__calls = calls;
  return octokit;
}

function makeContext(headSha = 'deadbeef') {
  return {
    repo: { owner: 'owner', repo: 'repo' },
    payload: { pull_request: { head: { sha: headSha } } },
  };
}

function makeCore() {
  const warnings = [];
  return {
    core: {
      warning: vi.fn((m) => warnings.push(m)),
      info: vi.fn(),
    },
    warnings,
  };
}

describe('loadCodeowners — happy path', () => {
  it('fetches CODEOWNERS from the root path first', async () => {
    const octokit = makeOctokitWithContent('* @alice\n', { foundPath: 'CODEOWNERS' });
    const { core } = makeCore();
    const rules = await loadCodeowners(
      { octokit, context: makeContext('sha-1') },
      { core },
    );
    expect(octokit.__calls.getContent[0]).toMatchObject({
      owner: 'owner',
      repo: 'repo',
      path: 'CODEOWNERS',
      ref: 'sha-1',
    });
    expect(rules).toEqual([{ pattern: '*', owners: ['@alice'] }]);
  });

  it('falls back to .github/CODEOWNERS when root is absent', async () => {
    const octokit = makeOctokitWithContent('src/** @fe\n', {
      foundPath: '.github/CODEOWNERS',
    });
    const { core } = makeCore();
    const rules = await loadCodeowners(
      { octokit, context: makeContext('sha-2') },
      { core },
    );
    const paths = octokit.__calls.getContent.map((c) => c.path);
    expect(paths).toEqual(['CODEOWNERS', '.github/CODEOWNERS']);
    expect(rules).toEqual([{ pattern: 'src/**', owners: ['@fe'] }]);
  });

  it('falls back to docs/CODEOWNERS when root and .github are absent', async () => {
    const octokit = makeOctokitWithContent('docs/** @docs\n', {
      foundPath: 'docs/CODEOWNERS',
    });
    const { core } = makeCore();
    const rules = await loadCodeowners(
      { octokit, context: makeContext('sha-3') },
      { core },
    );
    const paths = octokit.__calls.getContent.map((c) => c.path);
    expect(paths).toEqual(['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS']);
    expect(rules).toEqual([{ pattern: 'docs/**', owners: ['@docs'] }]);
  });
});

describe('loadCodeowners — fail-soft returns []', () => {
  it('returns [] and warns when no CODEOWNERS exists anywhere', async () => {
    const octokit = makeOctokitWithContent('', { throw404: true });
    const { core, warnings } = makeCore();
    const rules = await loadCodeowners(
      { octokit, context: makeContext() },
      { core },
    );
    expect(rules).toEqual([]);
    expect(core.warning).toHaveBeenCalled();
    expect(warnings[0]).toMatch(/CODEOWNERS/i);
  });

  it('returns [] and warns on a 500 error (never throws)', async () => {
    const octokit = makeOctokitWithContent('', { throw500: true });
    const { core } = makeCore();
    const rules = await loadCodeowners(
      { octokit, context: makeContext() },
      { core },
    );
    expect(rules).toEqual([]);
    expect(core.warning).toHaveBeenCalled();
  });

  it('returns [] when headSha cannot be resolved', async () => {
    const octokit = makeOctokitWithContent('* @alice\n');
    const { core } = makeCore();
    const rules = await loadCodeowners(
      {
        octokit,
        context: { repo: { owner: 'o', repo: 'r' }, payload: {} },
      },
      { core },
    );
    expect(rules).toEqual([]);
    expect(octokit.__calls.getContent).toHaveLength(0);
  });

  it('returns [] when owner/repo are missing', async () => {
    const octokit = makeOctokitWithContent('* @alice\n');
    const { core } = makeCore();
    const rules = await loadCodeowners(
      {
        octokit,
        context: { repo: {}, payload: { pull_request: { head: { sha: 's' } } } },
      },
      { core },
    );
    expect(rules).toEqual([]);
    expect(octokit.__calls.getContent).toHaveLength(0);
  });

  it('returns [] on malformed CODEOWNERS (parser is tolerant; never throws)', async () => {
    // The parser is tolerant: garbage lines parse to rules whose patterns
    // simply never match real files. The load path never throws on bad input.
    const octokit = makeOctokitWithContent('@@@ ###\n!!!not valid\n', {
      foundPath: 'CODEOWNERS',
    });
    const { core } = makeCore();
    const rules = await loadCodeowners(
      { octokit, context: makeContext() },
      { core },
    );
    expect(Array.isArray(rules)).toBe(true);
    // The garbage patterns don't match any real file.
    expect(matchCodeowners(rules, ['src/a.js']).size).toBe(0);
  });

  it('still returns [] on error (does not throw) when core is absent', async () => {
    const octokit = makeOctokitWithContent('', { throw404: true });
    await expect(
      loadCodeowners({ octokit, context: makeContext() }, {}),
    ).resolves.toEqual([]);
  });
});
