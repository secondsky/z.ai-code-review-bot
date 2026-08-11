/**
 * Tests for src/lib/learnings.js — `.zai/learnings.yml` memory.
 *
 * The file is attacker-controllable in fork PRs, so the parser must be
 * tolerant (never throw) and the validator must drop entries missing required
 * fields. Matching is conservative: a glob match on the file AND a
 * case-insensitive substring match on title/description both must hold before a
 * finding is suppressed.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  parseLearnings,
  matchesLearning,
  filterFindingsByLearnings,
  formatLearningsForPrompt,
  loadLearnings,
} from '../src/lib/learnings.js';

/* ------------------------------------------------------------------ *
 * parseLearnings
 * ------------------------------------------------------------------ */

describe('parseLearnings — valid document', () => {
  it('parses a well-formed learnings.yml with reason', () => {
    const text = `
learnings:
  - file: "src/auth.js"
    pattern: "hardcoded api key in tests"
    reason: "test fixtures use fake keys"
  - file: "**/*.test.js"
    pattern: "console.log"
    reason: "test files"
`;
    expect(parseLearnings(text)).toEqual([
      {
        file: 'src/auth.js',
        pattern: 'hardcoded api key in tests',
        reason: 'test fixtures use fake keys',
      },
      { file: '**/*.test.js', pattern: 'console.log', reason: 'test files' },
    ]);
  });

  it('parses unquoted scalar values', () => {
    const text = `
learnings:
  - file: src/foo.js
    pattern: todo
`;
    expect(parseLearnings(text)).toEqual([
      { file: 'src/foo.js', pattern: 'todo' },
    ]);
  });

  it('omits reason when not present', () => {
    const text = `
learnings:
  - file: "a.js"
    pattern: "x"
`;
    const out = parseLearnings(text);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ file: 'a.js', pattern: 'x' });
    expect('reason' in out[0]).toBe(false);
  });

  it('strips inline and full-line comments', () => {
    const text = `# header
learnings:
  - file: "a.js" # the file
    pattern: "x"
# trailing
`;
    expect(parseLearnings(text)).toEqual([{ file: 'a.js', pattern: 'x' }]);
  });

  it('preserves # inside quoted strings', () => {
    const text = `
learnings:
  - file: "a.js"
    pattern: "use # for headers"
`;
    expect(parseLearnings(text)).toEqual([
      { file: 'a.js', pattern: 'use # for headers' },
    ]);
  });
});

describe('parseLearnings — missing learnings key', () => {
  it('returns [] when the learnings key is absent', () => {
    expect(parseLearnings('reviews:\n  profile: chill\n')).toEqual([]);
  });

  it('returns [] for an empty learnings block', () => {
    expect(parseLearnings('learnings:\n')).toEqual([]);
  });

  it('returns [] for empty input', () => {
    expect(parseLearnings('')).toEqual([]);
  });

  it('returns [] for non-string input', () => {
    // @ts-expect-error — exercising the defensive path.
    expect(parseLearnings(null)).toEqual([]);
    // @ts-expect-error — exercising the defensive path.
    expect(parseLearnings(undefined)).toEqual([]);
  });
});

describe('parseLearnings — invalid entries dropped', () => {
  it('drops an entry missing pattern', () => {
    const text = `
learnings:
  - file: "a.js"
  - file: "b.js"
    pattern: "keep"
`;
    expect(parseLearnings(text)).toEqual([{ file: 'b.js', pattern: 'keep' }]);
  });

  it('drops an entry missing file', () => {
    const text = `
learnings:
  - pattern: "nope"
  - file: "b.js"
    pattern: "keep"
`;
    expect(parseLearnings(text)).toEqual([{ file: 'b.js', pattern: 'keep' }]);
  });

  it('drops an entry whose file is an empty string', () => {
    const text = `
learnings:
  - file: ""
    pattern: "x"
`;
    expect(parseLearnings(text)).toEqual([]);
  });

  it('drops an entry whose pattern is whitespace-only', () => {
    const text = `
learnings:
  - file: "a.js"
    pattern: "   "
`;
    expect(parseLearnings(text)).toEqual([]);
  });

  // W8-4: an unquoted value containing an apostrophe (e.g. "don't") previously
  // toggled inSingle permanently, so a trailing `# comment` was NOT stripped
  // and became part of the parsed value. Port the apostrophe-in-word guard
  // from repo-config.js.
  it('W8-4: apostrophe in unquoted value does not disable comment stripping', () => {
    const text = `learnings:\n  - file: a.js\n    pattern: don't flag # trailing\n`;
    const out = parseLearnings(text);
    expect(out).toHaveLength(1);
    // The trailing "# trailing" comment must be stripped; the value is "don't flag".
    expect(out[0].pattern).toBe("don't flag");
  });

  it('keeps a reason only when it is a non-empty string', () => {
    const text = `
learnings:
  - file: "a.js"
    pattern: "x"
    reason: ""
  - file: "b.js"
    pattern: "y"
    reason: "ok"
`;
    expect(parseLearnings(text)).toEqual([
      { file: 'a.js', pattern: 'x' },
      { file: 'b.js', pattern: 'y', reason: 'ok' },
    ]);
  });

  it('ignores unknown keys on an entry', () => {
    const text = `
learnings:
  - file: "a.js"
    pattern: "x"
    bogus: "drop me"
`;
    const out = parseLearnings(text);
    expect(out).toEqual([{ file: 'a.js', pattern: 'x' }]);
  });

  it('never throws on garbage input', () => {
    const garbage = '@@@\n!!!\n   - : \n  - file\n';
    expect(() => parseLearnings(garbage)).not.toThrow();
    expect(Array.isArray(parseLearnings(garbage))).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * matchesLearning
 * ------------------------------------------------------------------ */

describe('matchesLearning — glob + substring match', () => {
  it('matches when the file glob and the pattern substring both hit (title)', () => {
    const finding = {
      file: 'src/auth.js',
      title: 'Hardcoded API key detected',
      description: 'some desc',
    };
    const learning = { file: 'src/auth.js', pattern: 'hardcoded api key' };
    expect(matchesLearning(finding, learning)).toBe(true);
  });

  it('matches when the substring hits the description instead of the title', () => {
    const finding = {
      file: 'src/auth.js',
      title: 'Unrelated',
      description: 'This is a hardcoded API key in tests.',
    };
    const learning = { file: 'src/auth.js', pattern: 'hardcoded api key' };
    expect(matchesLearning(finding, learning)).toBe(true);
  });

  it('matches a glob against the basename (e.g. *.test.js)', () => {
    const finding = {
      file: 'tests/unit/foo.test.js',
      title: 'console.log left in code',
      description: '',
    };
    const learning = { file: '*.test.js', pattern: 'console.log' };
    expect(matchesLearning(finding, learning)).toBe(true);
  });

  it('matches a glob with ** against nested paths', () => {
    const finding = {
      file: 'packages/a/tests/b/c.test.js',
      title: 'console.log',
      description: '',
    };
    const learning = { file: '**/*.test.js', pattern: 'console.log' };
    expect(matchesLearning(finding, learning)).toBe(true);
  });
});

describe('matchesLearning — non-matching', () => {
  it('returns false when the glob does not match the file', () => {
    const finding = {
      file: 'src/auth.js',
      title: 'console.log',
      description: '',
    };
    const learning = { file: '*.test.js', pattern: 'console.log' };
    expect(matchesLearning(finding, learning)).toBe(false);
  });

  it('returns false when the pattern substring is absent', () => {
    const finding = {
      file: 'src/auth.js',
      title: 'SQL injection risk',
      description: 'user input concatenated',
    };
    const learning = { file: 'src/auth.js', pattern: 'console.log' };
    expect(matchesLearning(finding, learning)).toBe(false);
  });

  it('returns false when the finding has no file', () => {
    const finding = { title: 'x', description: 'y' };
    const learning = { file: 'a.js', pattern: 'x' };
    expect(matchesLearning(finding, learning)).toBe(false);
  });

  it('returns false when the learning has no pattern', () => {
    const finding = { file: 'a.js', title: 'x', description: 'y' };
    // @ts-expect-error — exercising the defensive path.
    const learning = { file: 'a.js' };
    expect(matchesLearning(finding, learning)).toBe(false);
  });

  it('returns false for non-object inputs', () => {
    expect(matchesLearning(null, { file: 'a.js', pattern: 'x' })).toBe(false);
    expect(
      matchesLearning({ file: 'a.js', title: 'x', description: '' }, null),
    ).toBe(false);
  });
});

describe('matchesLearning — case-insensitivity', () => {
  it('matches regardless of case in the pattern vs finding text', () => {
    // Glob matching on the file is case-sensitive (filesystem-accurate); only
    // the pattern-substring match is case-insensitive. Same file path here so
    // we isolate the substring case-insensitivity contract.
    const finding = {
      file: 'src/auth.js',
      title: 'HARDCODED API KEY',
      description: '',
    };
    const learning = { file: 'src/auth.js', pattern: 'hardcoded api key' };
    expect(matchesLearning(finding, learning)).toBe(true);
  });

  it('matches a mixed-case pattern against a lowercase description', () => {
    const finding = {
      file: 'a.js',
      title: 'x',
      description: 'use Console.Log here',
    };
    const learning = { file: 'a.js', pattern: 'console.log' };
    expect(matchesLearning(finding, learning)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * filterFindingsByLearnings
 * ------------------------------------------------------------------ */

describe('filterFindingsByLearnings', () => {
  const findings = [
    { file: 'src/auth.js', title: 'Hardcoded API key', description: '' },
    { file: 'src/db.js', title: 'SQL injection', description: 'unsafe query' },
    { file: 'tests/a.test.js', title: 'console.log left', description: '' },
  ];

  it('suppresses findings that match a learning and keeps the rest', () => {
    const learnings = [
      { file: 'src/auth.js', pattern: 'hardcoded api key' },
      { file: '*.test.js', pattern: 'console.log' },
    ];
    const { kept, suppressed } = filterFindingsByLearnings(findings, learnings);
    expect(kept).toEqual([
      { file: 'src/db.js', title: 'SQL injection', description: 'unsafe query' },
    ]);
    expect(suppressed).toBe(2);
  });

  it('keeps everything when no learning matches', () => {
    const learnings = [{ file: 'docs/**', pattern: 'typo' }];
    const { kept, suppressed } = filterFindingsByLearnings(findings, learnings);
    expect(kept).toHaveLength(3);
    expect(suppressed).toBe(0);
  });

  it('keeps everything when the learnings list is empty', () => {
    const { kept, suppressed } = filterFindingsByLearnings(findings, []);
    expect(kept).toHaveLength(3);
    expect(suppressed).toBe(0);
  });

  it('keeps everything when the learnings list is absent', () => {
    // @ts-expect-error — exercising the defensive path.
    const { kept, suppressed } = filterFindingsByLearnings(findings, undefined);
    expect(kept).toHaveLength(3);
    expect(suppressed).toBe(0);
  });

  it('returns { kept: [], suppressed: 0 } for non-array findings', () => {
    // @ts-expect-error — exercising the defensive path.
    const result = filterFindingsByLearnings(null, [
      { file: 'a.js', pattern: 'x' },
    ]);
    expect(result.kept).toEqual([]);
    expect(result.suppressed).toBe(0);
  });

  it('preserves input order of the kept findings', () => {
    const learnings = [{ file: 'src/auth.js', pattern: 'hardcoded' }];
    const { kept } = filterFindingsByLearnings(findings, learnings);
    expect(kept.map((f) => f.file)).toEqual(['src/db.js', 'tests/a.test.js']);
  });

  it('suppresses everything when one broad learning matches all', () => {
    const learnings = [{ file: '**', pattern: 'o' }];
    const { kept, suppressed } = filterFindingsByLearnings(findings, learnings);
    expect(kept).toEqual([]);
    expect(suppressed).toBe(3);
  });
});

/* ------------------------------------------------------------------ *
 * formatLearningsForPrompt
 * ------------------------------------------------------------------ */

describe('formatLearningsForPrompt', () => {
  it('renders the context block for a non-empty list', () => {
    const out = formatLearningsForPrompt([
      { file: 'src/auth.js', pattern: 'hardcoded api key' },
      { file: '**/*.test.js', pattern: 'console.log' },
    ]);
    expect(out).toBe(
      'The following patterns have been previously reviewed and accepted — do not flag them:\n' +
        '- src/auth.js: hardcoded api key\n' +
        '- **/*.test.js: console.log',
    );
  });

  it('returns "" for an empty list', () => {
    expect(formatLearningsForPrompt([])).toBe('');
  });

  it('returns "" for a non-array input', () => {
    // @ts-expect-error — exercising the defensive path.
    expect(formatLearningsForPrompt(null)).toBe('');
    // @ts-expect-error — exercising the defensive path.
    expect(formatLearningsForPrompt(undefined)).toBe('');
  });

  it('skips malformed entries (missing pattern) and still renders the rest', () => {
    const out = formatLearningsForPrompt([
      { file: 'a.js', pattern: 'x' },
      // @ts-expect-error — exercising the defensive path.
      { file: 'b.js' },
    ]);
    expect(out).toContain('- a.js: x');
    expect(out).not.toContain('b.js');
  });

  it('returns "" when every entry is malformed', () => {
    // @ts-expect-error — exercising the defensive path.
    expect(formatLearningsForPrompt([{ file: 'b.js' }])).toBe('');
  });
});

/* ------------------------------------------------------------------ *
 * loadLearnings
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
          return { data: { content: encoded, encoding: 'base64' } };
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

describe('loadLearnings — happy path', () => {
  it('fetches, decodes, and parses .zai/learnings.yml', async () => {
    const octokit = makeOctokitWithContent(
      'learnings:\n  - file: "a.js"\n    pattern: "x"\n',
    );
    const { core } = makeCore();
    const out = await loadLearnings(
      { octokit, context: makeContext('sha-1') },
      { core },
    );
    expect(octokit.__calls.getContent[0]).toMatchObject({
      owner: 'owner',
      repo: 'repo',
      path: '.zai/learnings.yml',
      ref: 'sha-1',
    });
    expect(out).toEqual([{ file: 'a.js', pattern: 'x' }]);
  });

  it('honors a custom path', async () => {
    const octokit = makeOctokitWithContent(
      'learnings:\n  - file: "a.js"\n    pattern: "x"\n',
    );
    const { core } = makeCore();
    await loadLearnings(
      { octokit, context: makeContext('sha-1'), path: 'custom/learnings.yml' },
      { core },
    );
    expect(octokit.__calls.getContent[0].path).toBe('custom/learnings.yml');
  });

  it('uses opts.headSha over the PR payload', async () => {
    const octokit = makeOctokitWithContent(
      'learnings:\n  - file: "a.js"\n    pattern: "x"\n',
    );
    const { core } = makeCore();
    await loadLearnings(
      { octokit, context: makeContext('payload-sha'), headSha: 'explicit-sha' },
      { core },
    );
    expect(octokit.__calls.getContent[0].ref).toBe('explicit-sha');
  });

  it('drops invalid entries but keeps valid ones', async () => {
    const octokit = makeOctokitWithContent(
      'learnings:\n  - file: "a.js"\n  - file: "b.js"\n    pattern: "keep"\n',
    );
    const { core } = makeCore();
    const out = await loadLearnings(
      { octokit, context: makeContext() },
      { core },
    );
    expect(out).toEqual([{ file: 'b.js', pattern: 'keep' }]);
  });
});

describe('loadLearnings — fail-soft returns []', () => {
  it('returns [] and warns on 404 (never throws)', async () => {
    const octokit = makeOctokitWithContent('', { throw404: true });
    const { core, warnings } = makeCore();
    const out = await loadLearnings(
      { octokit, context: makeContext() },
      { core },
    );
    expect(out).toEqual([]);
    expect(core.warning).toHaveBeenCalled();
    expect(warnings[0]).toMatch(/404/);
  });

  it('returns [] and warns on a 500 error (never throws)', async () => {
    const octokit = makeOctokitWithContent('', { throw500: true });
    const { core } = makeCore();
    const out = await loadLearnings(
      { octokit, context: makeContext() },
      { core },
    );
    expect(out).toEqual([]);
    expect(core.warning).toHaveBeenCalled();
  });

  it('returns [] when headSha cannot be resolved', async () => {
    const octokit = makeOctokitWithContent(
      'learnings:\n  - file: "a.js"\n    pattern: "x"\n',
    );
    const { core } = makeCore();
    const out = await loadLearnings(
      { octokit, context: { repo: { owner: 'o', repo: 'r' }, payload: {} } },
      { core },
    );
    expect(out).toEqual([]);
    expect(octokit.__calls.getContent).toHaveLength(0);
  });

  it('returns [] when owner/repo are missing', async () => {
    const octokit = makeOctokitWithContent(
      'learnings:\n  - file: "a.js"\n    pattern: "x"\n',
    );
    const { core } = makeCore();
    const out = await loadLearnings(
      {
        octokit,
        context: {
          repo: {},
          payload: { pull_request: { head: { sha: 's' } } },
        },
      },
      { core },
    );
    expect(out).toEqual([]);
    expect(octokit.__calls.getContent).toHaveLength(0);
  });

  it('returns [] and warns on malformed YAML with no valid entries', async () => {
    const octokit = makeOctokitWithContent('@@@ ###\n!!!not valid\n');
    const { core, warnings } = makeCore();
    const out = await loadLearnings(
      { octokit, context: makeContext() },
      { core },
    );
    expect(out).toEqual([]);
    expect(warnings.some((w) => /no valid entries/i.test(w))).toBe(true);
  });

  it('still returns [] on error (does not throw) when core is absent', async () => {
    const octokit = makeOctokitWithContent('', { throw404: true });
    await expect(
      loadLearnings({ octokit, context: makeContext() }, {}),
    ).resolves.toEqual([]);
  });
});
