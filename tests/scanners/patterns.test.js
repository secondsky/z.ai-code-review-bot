/**
 * Tests for the code-pattern scanner (src/lib/scanners/patterns.js).
 *
 * Coverage:
 *   - DEFAULT_PATTERN_RULES: shape
 *   - astGrepPatternToRegex: wildcard translation, escaping
 *   - fileMatchesLanguages: language detection by extension
 *   - scanPatternsRegex: each rule fires on its canonical sample; language
 *     filtering; line mapping; never throws on bad input
 *   - mapAstGrepFinding / parseAstGrepJson: shape, ruleIndex enrichment
 *   - scanPatterns (async): ast-grep path with fake runBinary; fallback paths
 *
 * No real binaries are executed.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  scanPatterns,
  scanPatternsRegex,
  astGrepPatternToRegex,
  fileMatchesLanguages,
  DEFAULT_PATTERN_RULES,
  parseAstGrepJson,
  mapAstGrepFinding,
  AST_GREP_SPEC,
} from '../../src/lib/scanners/patterns.js';

function buildPatch(addedTexts, startLine = 1) {
  const lines = [`@@ -1,${addedTexts.length} +${startLine},${addedTexts.length} @@`];
  for (const t of addedTexts) lines.push(`+${t}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// DEFAULT_PATTERN_RULES
// ---------------------------------------------------------------------------

describe('DEFAULT_PATTERN_RULES', () => {
  it('is a non-empty array of rule objects', () => {
    expect(Array.isArray(DEFAULT_PATTERN_RULES)).toBe(true);
    expect(DEFAULT_PATTERN_RULES.length).toBeGreaterThan(5);
  });

  it('every rule has the required fields', () => {
    for (const r of DEFAULT_PATTERN_RULES) {
      expect(typeof r.id).toBe('string');
      expect(typeof r.pattern).toBe('string');
      expect(typeof r.severity).toBe('string');
      expect(typeof r.category).toBe('string');
      expect(Array.isArray(r.languages)).toBe(true);
      expect(typeof r.title).toBe('string');
    }
  });

  it('includes the core rule ids', () => {
    const ids = DEFAULT_PATTERN_RULES.map((r) => r.id);
    for (const id of ['eval', 'innerHTML', 'dangerouslySetInnerHTML', 'exec',
      'tls-reject-unauthorized', 'sql-concat', 'todo-in-code', 'fixme-in-code',
      'console-log']) {
      expect(ids).toContain(id);
    }
  });
});

// ---------------------------------------------------------------------------
// astGrepPatternToRegex
// ---------------------------------------------------------------------------

describe('astGrepPatternToRegex', () => {
  it('returns null for empty/invalid input', () => {
    expect(astGrepPatternToRegex('')).toBeNull();
    expect(astGrepPatternToRegex(null)).toBeNull();
  });

  it('translates $$$ARGS to .*?', () => {
    const re = astGrepPatternToRegex('eval($$$ARGS)');
    expect(re).toBeInstanceOf(RegExp);
    expect(re.test('eval("foo")')).toBe(true);
    expect(re.test('eval(x, y, z)')).toBe(true);
    // `eval` is a substring of `noteval`, so the line-based match fires.
    // (ast-grep would NOT match — the regex fallback is less precise by design.)
    expect(re.test('noteval')).toBe(true);
    // Anchoring the search demonstrates the regex works as expected.
    expect(re.test(' eval("foo")')).toBe(true);
  });

  it('translates $VALUE / $VAR / $X to .*?', () => {
    const re = astGrepPatternToRegex('innerHTML = $VALUE');
    expect(re.test('innerHTML = "evil"')).toBe(true);
    expect(re.test('innerHTML = foo.bar')).toBe(true);
  });

  it('escapes regex metacharacters in literals', () => {
    const re = astGrepPatternToRegex('child_process.exec($CMD)');
    expect(re.test('child_process.exec(userInput)')).toBe(true);
    // `(` and `)` are intentionally NOT escaped (they're structural chars in
    // ast-grep patterns and match literally in JS regex when not part of a
    // group). The literal `.` IS escaped — verifying with a string that
    // differs in the dot position only.
    expect(re.test('child_processXexec(userInput)')).toBe(false);
  });

  it('handles a plain string pattern (no wildcards)', () => {
    const re = astGrepPatternToRegex('rejectUnauthorized: false');
    expect(re.test('  rejectUnauthorized: false')).toBe(true);
  });

  it('handles a TODO marker (substring match)', () => {
    const re = astGrepPatternToRegex('TODO');
    expect(re.test('// TODO: fix this')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fileMatchesLanguages
// ---------------------------------------------------------------------------

describe('fileMatchesLanguages', () => {
  it('matches everything when languages includes *', () => {
    expect(fileMatchesLanguages('README.md', ['*'])).toBe(true);
    expect(fileMatchesLanguages('foo.js', ['*'])).toBe(true);
  });

  it('matches everything when languages is empty/missing', () => {
    expect(fileMatchesLanguages('foo.js', [])).toBe(true);
    expect(fileMatchesLanguages('foo.js', null)).toBe(true);
  });

  it('matches by extension via the extToLang map', () => {
    expect(fileMatchesLanguages('foo.js', ['js'])).toBe(true);
    expect(fileMatchesLanguages('foo.mjs', ['js'])).toBe(true);
    expect(fileMatchesLanguages('foo.cjs', ['js'])).toBe(true);
    expect(fileMatchesLanguages('foo.ts', ['ts'])).toBe(true);
    expect(fileMatchesLanguages('foo.tsx', ['tsx'])).toBe(true);
    expect(fileMatchesLanguages('foo.jsx', ['jsx'])).toBe(true);
  });

  it('rejects non-matching languages', () => {
    expect(fileMatchesLanguages('foo.js', ['ts'])).toBe(false);
    expect(fileMatchesLanguages('README.md', ['js'])).toBe(false);
  });

  it('rejects dotfiles and unknown extensions', () => {
    expect(fileMatchesLanguages('.eslintrc', ['js'])).toBe(false);
    expect(fileMatchesLanguages('foo', ['js'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scanPatternsRegex — rule coverage
// ---------------------------------------------------------------------------

describe('scanPatternsRegex — rule coverage', () => {
  it('detects eval()', () => {
    const findings = scanPatternsRegex([
      { filename: 'src/eval.js', patch: buildPatch(['eval("alert(1)")']) },
    ]);
    const evalFinding = findings.find((f) => f.rule === 'astgrep:eval');
    expect(evalFinding).toBeTruthy();
    expect(evalFinding.severity).toBe('high');
    expect(evalFinding.category).toBe('security');
  });

  it('detects innerHTML assignment', () => {
    const findings = scanPatternsRegex([
      { filename: 'src/dom.js', patch: buildPatch(['el.innerHTML = userInput;']) },
    ]);
    expect(findings.find((f) => f.rule === 'astgrep:innerHTML')).toBeTruthy();
  });

  it('detects child_process.exec', () => {
    const findings = scanPatternsRegex([
      { filename: 'src/run.js', patch: buildPatch(['child_process.exec(`ls ${userInput}`)']) },
    ]);
    expect(findings.find((f) => f.rule === 'astgrep:exec')).toBeTruthy();
  });

  it('detects rejectUnauthorized:false', () => {
    const findings = scanPatternsRegex([
      { filename: 'src/tls.js', patch: buildPatch(['  rejectUnauthorized: false,']) },
    ]);
    expect(findings.find((f) => f.rule === 'astgrep:tls-reject-unauthorized')).toBeTruthy();
  });

  it('detects console.log', () => {
    const findings = scanPatternsRegex([
      { filename: 'src/dbg.js', patch: buildPatch(['console.log("debug", obj);']) },
    ]);
    const cl = findings.find((f) => f.rule === 'astgrep:console-log');
    expect(cl).toBeTruthy();
    expect(cl.severity).toBe('low');
  });

  it('detects TODO and FIXME', () => {
    const findings = scanPatternsRegex([
      { filename: 'src/x.js', patch: buildPatch(['// TODO: fix later']) },
      { filename: 'src/y.js', patch: buildPatch(['# FIXME: broken']) },
      { filename: 'src/z.md', patch: buildPatch(['- TODO: do something']) },
    ]);
    const rules = findings.map((f) => f.rule).sort();
    expect(rules).toContain('astgrep:todo-in-code');
    expect(rules).toContain('astgrep:fixme-in-code');
  });

  it('detects dangerouslySetInnerHTML only in jsx/tsx', () => {
    // jsx matches
    const findingsJsx = scanPatternsRegex([
      { filename: 'src/C.jsx', patch: buildPatch(['<div dangerouslySetInnerHTML={{__html: x}} />']) },
    ]);
    expect(findingsJsx.some((f) => f.rule === 'astgrep:dangerouslySetInnerHTML')).toBe(true);

    // .md does not match (language-filtered)
    const findingsMd = scanPatternsRegex([
      { filename: 'README.md', patch: buildPatch(['dangerouslySetInnerHTML={x}']) },
    ]);
    expect(findingsMd.some((f) => f.rule === 'astgrep:dangerouslySetInnerHTML')).toBe(false);
  });
});

describe('scanPatternsRegex — language filtering', () => {
  it('does NOT run js-only rules on .md files', () => {
    const findings = scanPatternsRegex([
      { filename: 'README.md', patch: buildPatch(['eval("x")']) },
    ]);
    expect(findings.find((f) => f.rule === 'astgrep:eval')).toBeUndefined();
  });

  it('runs language-* rules on any file', () => {
    const findings = scanPatternsRegex([
      { filename: 'README.md', patch: buildPatch(['- TODO: do']) },
    ]);
    expect(findings.find((f) => f.rule === 'astgrep:todo-in-code')).toBeTruthy();
  });
});

describe('scanPatternsRegex — line mapping & robustness', () => {
  it('reports absolute (new-file) line numbers', () => {
    const patch = [
      '@@ -10,3 +50,3 @@',
      ' context', // 50
      '-removed',
      '+eval("x")', // 51
    ].join('\n');
    const findings = scanPatternsRegex([{ filename: 'a.js', patch }]);
    const evalFinding = findings.find((f) => f.rule === 'astgrep:eval');
    expect(evalFinding.line).toBe(51);
  });

  it('returns [] for non-array input', () => {
    // @ts-expect-error
    expect(scanPatternsRegex(null)).toEqual([]);
    // @ts-expect-error
    expect(scanPatternsRegex(undefined)).toEqual([]);
  });

  it('skips files without filename or patch', () => {
    expect(scanPatternsRegex([{ patch: '+eval("x")' }])).toEqual([]);
    expect(scanPatternsRegex([{ filename: 'a.js' }])).toEqual([]);
  });

  it('does not flag context or removed lines', () => {
    const patch = [
      '@@ -1,3 +1,3 @@',
      '-eval("removed")',
      ' eval("context")',
      '+// safe',
    ].join('\n');
    const findings = scanPatternsRegex([{ filename: 'a.js', patch }]);
    expect(findings).toEqual([]);
  });

  it('respects a custom rule set', () => {
    const customRules = [
      {
        id: 'my-rule',
        pattern: 'debuggerStatement()',
        severity: 'low',
        category: 'style',
        languages: ['js'],
        title: 'Custom rule',
      },
    ];
    const findings = scanPatternsRegex(
      [{ filename: 'a.js', patch: buildPatch(['debuggerStatement()']) }],
      customRules,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe('astgrep:my-rule');
  });
});

// ---------------------------------------------------------------------------
// ast-grep JSON mapping
// ---------------------------------------------------------------------------

describe('mapAstGrepFinding', () => {
  it('maps a canonical ast-grep match to the schema', () => {
    const f = mapAstGrepFinding(
      {
        text: 'eval("alert(1)")',
        file: 'src/foo.js',
        lines: { start: 42, end: 42 },
        ruleId: 'eval',
      },
      new Map([['eval', { title: 'Use of eval()', severity: 'high', category: 'security' }]]),
    );
    expect(f).toMatchObject({
      file: 'src/foo.js',
      line: 42,
      severity: 'high',
      category: 'security',
      title: 'Use of eval()',
      rule: 'astgrep:eval',
    });
  });

  it('falls back when ruleId is missing', () => {
    const f = mapAstGrepFinding({
      text: 'eval("x")',
      file: 'a.js',
      lines: { start: 1 },
    });
    expect(f.rule).toBe('astgrep:match');
    expect(f.severity).toBe('medium');
  });

  it('returns null when File is missing', () => {
    expect(mapAstGrepFinding({ text: 'x', lines: { start: 1 } })).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(mapAstGrepFinding(null)).toBeNull();
    expect(mapAstGrepFinding('foo')).toBeNull();
  });

  it('handles missing lines (line → null)', () => {
    const f = mapAstGrepFinding({ text: 'x', file: 'a.js' });
    expect(f.line).toBeNull();
  });
});

describe('parseAstGrepJson', () => {
  it('parses a top-level array of matches', () => {
    const json = JSON.stringify([
      { text: 'eval(x)', file: 'a.js', lines: { start: 1 }, ruleId: 'eval' },
      { text: 'TODO', file: 'b.js', lines: { start: 5 }, ruleId: 'todo' },
    ]);
    const findings = parseAstGrepJson(json);
    expect(findings).toHaveLength(2);
    expect(findings[0].rule).toBe('astgrep:eval');
  });

  it('returns [] for empty/invalid input', () => {
    expect(parseAstGrepJson('')).toEqual([]);
    expect(parseAstGrepJson(null)).toEqual([]);
    expect(parseAstGrepJson('not json')).toEqual([]);
    expect(parseAstGrepJson('{}')).toEqual([]);
  });

  it('skips entries without a File', () => {
    const json = JSON.stringify([
      { text: 'x', file: 'a.js', lines: { start: 1 } },
      { text: 'y', lines: { start: 5 } },
    ]);
    expect(parseAstGrepJson(json)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// scanPatterns — async orchestration
// ---------------------------------------------------------------------------

describe('scanPatterns — ast-grep path (fake runBinary)', () => {
  it('uses ast-grep when deps.runBinary + ensureBinary are provided', async () => {
    // The fake returns [] for every rule except `eval`, where it returns one
    // finding. The orchestrator calls runBinary once per non-`*` rule.
    const fakeRunBinary = vi.fn().mockImplementation((path, args) => {
      const patternIdx = args.indexOf('--pattern');
      const pattern = patternIdx >= 0 ? args[patternIdx + 1] : '';
      if (pattern.includes('$$') || pattern.includes('eval')) {
        // Match the eval rule's pattern.
        if (pattern.startsWith('eval')) {
          return Promise.resolve(
            JSON.stringify([
              {
                text: 'eval("alert(1)")',
                file: 'src/foo.js',
                lines: { start: 42, end: 42 },
                ruleId: 'eval',
              },
            ]),
          );
        }
      }
      return Promise.resolve('[]');
    });
    const fakeEnsureBinary = vi.fn().mockResolvedValue('/cache/ast-grep/ast-grep');
    const result = await scanPatterns(
      { files: [], repoPath: '/repo', cacheDir: '/cache' },
      {
        ensureBinary: fakeEnsureBinary,
        runBinary: fakeRunBinary,
        platform: 'linux',
        arch: 'x64',
      },
    );
    expect(result.scanner).toBe('ast-grep');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].rule).toBe('astgrep:eval');
    expect(result.findings[0].file).toBe('src/foo.js');
    expect(result.findings[0].line).toBe(42);
    // runBinary invoked once per non-`*` rule
    const nonStarRules = DEFAULT_PATTERN_RULES.filter(
      (r) => !r.languages.includes('*'),
    );
    expect(fakeRunBinary).toHaveBeenCalledTimes(nonStarRules.length);
    const args = fakeRunBinary.mock.calls[0][1];
    expect(args).toContain('run');
    expect(args).toContain('--json');
  });
});

describe('scanPatterns — fallback paths', () => {
  it('falls back when ensureBinary is missing', async () => {
    const result = await scanPatterns(
      { files: [{ filename: 'a.js', patch: buildPatch(['eval("x")']) }], repoPath: '/r' },
      { runBinary: vi.fn() },
    );
    expect(result.scanner).toBe('regex-fallback');
    expect(result.findings.find((f) => f.rule === 'astgrep:eval')).toBeTruthy();
  });

  it('falls back when runBinary throws', async () => {
    const warnings = [];
    const result = await scanPatterns(
      { files: [{ filename: 'a.js', patch: buildPatch(['eval("x")']) }], repoPath: '/r' },
      {
        ensureBinary: vi.fn().mockResolvedValue('/p'),
        runBinary: vi.fn().mockRejectedValue(new Error('ast-grep crashed')),
        core: { warning: (m) => warnings.push(m) },
      },
    );
    expect(result.scanner).toBe('regex-fallback');
    expect(warnings[0]).toMatch(/ast-grep unavailable/);
  });

  it('falls back when ensureBinary throws', async () => {
    const result = await scanPatterns(
      { files: [{ filename: 'a.js', patch: buildPatch(['eval("x")']) }], repoPath: '/r' },
      {
        ensureBinary: vi.fn().mockRejectedValue(new Error('checksum mismatch')),
        runBinary: vi.fn(),
      },
    );
    expect(result.scanner).toBe('regex-fallback');
  });

  it('returns ast-grep result with [] when output is unparseable (no error thrown)', async () => {
    const result = await scanPatterns(
      { files: [], repoPath: '/r' },
      {
        ensureBinary: vi.fn().mockResolvedValue('/p'),
        runBinary: vi.fn().mockResolvedValue('not json'),
      },
    );
    expect(result.scanner).toBe('ast-grep');
    expect(result.findings).toEqual([]);
  });
});

describe('AST_GREP_SPEC shape', () => {
  it('exposes name/version/urls/checksums', () => {
    expect(AST_GREP_SPEC.name).toBe('ast-grep');
    expect(typeof AST_GREP_SPEC.version).toBe('string');
    expect(AST_GREP_SPEC.urls.darwin_arm64).toMatch(/^https:\/\//);
    expect(AST_GREP_SPEC.checksums.darwin_arm64).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ships REAL SHA256 checksums (not placeholders)', () => {
    // ast-grep publishes NO upstream checksum file, so these digests were
    // computed locally via `shasum -a 256` against the downloaded zips.
    // Lock them in so a regression to 0000…0000 placeholders is caught.
    expect(AST_GREP_SPEC.checksums).toEqual({
      darwin_arm64: 'eb0f2fb1b5f6e2210fe8bde4213264f855858adc793d48f14778b57e1f803749',
      darwin_x64: '4533770d6f9ca098ee4fd07c854d5862576b09c66cb24dba5c39a9a69e5a15f5',
      linux_arm64: 'cfaae1bf9d9e501471914b7e2c8253f4544ec75e017322079ca4a503f6787003',
      linux_x64: '9b58dfb710e98929beeebf7bb1efdf88751d6396275bf750cf79895835592715',
      win32_x64: '3b6f6797e54edda4b1b2a7dbaf9038c420a872f2f6f7415a7c52c6c6a5d094dc',
    });
    for (const csum of Object.values(AST_GREP_SPEC.checksums)) {
      expect(csum).toMatch(/^[0-9a-f]{64}$/);
      expect(csum).not.toMatch(/^0{16}/);
    }
  });

  it('uses the corrected app-* asset names and .zip archives for ALL platforms', () => {
    // Critical correction: the old spec had `astgrep-*` (raw binary) names.
    // The real assets use the `app-*` prefix and ship as .zip everywhere.
    const base = 'https://github.com/ast-grep/ast-grep/releases/download/0.34.3/';
    expect(AST_GREP_SPEC.urls.darwin_arm64).toBe(`${base}app-aarch64-apple-darwin.zip`);
    expect(AST_GREP_SPEC.urls.darwin_x64).toBe(`${base}app-x86_64-apple-darwin.zip`);
    expect(AST_GREP_SPEC.urls.linux_arm64).toBe(`${base}app-aarch64-unknown-linux-gnu.zip`);
    expect(AST_GREP_SPEC.urls.linux_x64).toBe(`${base}app-x86_64-unknown-linux-gnu.zip`);
    expect(AST_GREP_SPEC.urls.win32_x64).toBe(`${base}app-x86_64-pc-windows-msvc.zip`);
    for (const url of Object.values(AST_GREP_SPEC.urls)) {
      expect(url.endsWith('.zip')).toBe(true);
    }
  });

  it('declares archiveType=zip and a zip extractor (all platforms are .zip)', () => {
    expect(AST_GREP_SPEC.archiveType).toBe('zip');
    expect(typeof AST_GREP_SPEC.extractor).toBe('function');
  });
});
