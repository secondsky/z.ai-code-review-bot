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
  filenameToLanguage,
  DEFAULT_PATTERN_RULES,
  parseAstGrepJson,
  mapAstGrepFinding,
  normalizeFindingFilePath,
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
    // Parens are now escaped (W2-02), so `noteval` (no paren after `eval`)
    // correctly does NOT match — the regex fallback is now more precise.
    expect(re.test('noteval')).toBe(false);
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

  it('adds a TRAILING word boundary to bare-identifier patterns [W15-A5-7]', () => {
    // A bare-identifier pattern (letters/digits/underscore only) must be
    // wrapped in \b...\b so `TODO` doesn't prefix-match `TODOS`.
    const re = astGrepPatternToRegex('TODO');
    expect(re.source).toBe('\\bTODO\\b');
    expect(re.test('const TODOS = [1, 2, 3];')).toBe(false);
    expect(re.test('const TODO = 1;')).toBe(true);
    expect(re.test('// TODO fix')).toBe(true);
    // Non-identifier patterns (with punctuation/wildcards) keep the leading
    // \b only — no trailing boundary is added.
    const evalRe = astGrepPatternToRegex('eval($$$ARGS)');
    expect(evalRe.source.startsWith('\\b')).toBe(true);
    expect(evalRe.source.endsWith('\\b')).toBe(false);
  });

  it('does NOT emit a regex beginning with .*? (ReDoS guard)', () => {
    // A leading unanchored `.*?` causes catastrophic backtracking on long
    // near-miss lines. The sql-concat rule (`$CONN.query("$$$" + $VAR)`)
    // historically translated to a regex starting with `.*?`.
    const re = astGrepPatternToRegex('$CONN.query("$$$" + $VAR)');
    expect(re).toBeInstanceOf(RegExp);
    // The regex source must NOT start with the unanchored wildcard `.*?`.
    expect(re.source.startsWith('.*?')).toBe(false);
  });

  it('sql-concat regex completes quickly on a long near-miss line (no ReDoS)', () => {
    // A pathological line that nearly matches (lots of `a`s, never hits the
    // required `.query("` literal). Must complete in well under a second.
    const re = astGrepPatternToRegex('$CONN.query("$$$" + $VAR)');
    expect(re).toBeInstanceOf(RegExp);
    const evil = '+const x = ' + 'a'.repeat(50000) + '!';
    const start = Date.now();
    re.lastIndex = 0;
    re.test(evil);
    const elapsed = Date.now() - start;
    // Generous threshold (a well-behaved regex is <50ms; ReDoS is >1000ms).
    expect(elapsed).toBeLessThan(500);
  });

  it('sql-concat rule still matches a real SQL-concat line after the ReDoS fix', () => {
    // The fix must not break legitimate detection. Parens are now escaped
    // (W2-02), so the regex matches real parenthesized SQL-concat code.
    const re = astGrepPatternToRegex('$CONN.query("$$$" + $VAR)');
    expect(re.test('const r = conn.query("SELECT * FROM users" + userId)')).toBe(true);
  });

  it('escapes { and } in literal portions so {2} is not a quantifier [SCN-9]', () => {
    // A custom pattern with `{2}` must match the LITERAL string `foo{2}`,
    // not behave as the regex quantifier `foo{2}` (== `fooo`).
    const re = astGrepPatternToRegex('foo{2}');
    expect(re).toBeInstanceOf(RegExp);
    expect(re.test('foo{2}')).toBe(true);
    // If `{2}` were treated as a quantifier, this would match `fooo` — it must NOT.
    expect(re.test('fooo')).toBe(false);
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

describe('filenameToLanguage [W15-A5-2]', () => {
  it('maps extensions to ast-grep language names (same map as the fallback)', () => {
    expect(filenameToLanguage('a.js')).toBe('js');
    expect(filenameToLanguage('a.mjs')).toBe('js');
    expect(filenameToLanguage('a.cjs')).toBe('js');
    expect(filenameToLanguage('src/a.ts')).toBe('ts');
    expect(filenameToLanguage('src/C.jsx')).toBe('jsx');
    expect(filenameToLanguage('src/C.tsx')).toBe('tsx');
  });

  it('returns null for unknown extensions, dotfiles, and bad input', () => {
    expect(filenameToLanguage('README.md')).toBeNull();
    expect(filenameToLanguage('.eslintrc')).toBeNull();
    expect(filenameToLanguage('foo')).toBeNull();
    expect(filenameToLanguage(null)).toBeNull();
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

  it('does NOT flag eval() on substring like medieval(castle) [SCN-7]', () => {
    // Without a leading word boundary, `eval($$$ARGS)` → `/eval\(.*?\)/`
    // matches `medieval(castle)` because `eval(` is a substring. The fix
    // prepends `\b` when the pattern begins with a literal identifier.
    const findings = scanPatternsRegex([
      { filename: 'src/castle.js', patch: buildPatch(['medieval(castle)']) },
    ]);
    const evalFinding = findings.find((f) => f.rule === 'astgrep:eval');
    expect(evalFinding).withContext('medieval(castle) is not eval()').toBeUndefined();

    // And a real eval() still fires.
    const findings2 = scanPatternsRegex([
      { filename: 'src/x.js', patch: buildPatch(['eval(x)']) },
    ]);
    expect(findings2.find((f) => f.rule === 'astgrep:eval')).toBeTruthy();
  });

  it('detects innerHTML assignment with NO spaces (innerHTML=value) [SCN-8]', () => {
    // The pattern `innerHTML = $VALUE` has literal spaces; without whitespace
    // collapsing it misses `innerHTML=untrusted`. The fix collapses runs of
    // literal whitespace to `\s+`.
    const re = astGrepPatternToRegex('innerHTML = $VALUE');
    expect(re.test('innerHTML=untrusted')).toBe(true);
    // And the spaced form still works.
    expect(re.test('innerHTML = untrusted')).toBe(true);
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

  it('does NOT flag TODOS/FIXMES identifiers as TODO/FIXME markers [W15-A5-7]', () => {
    // Without a trailing \b on bare-identifier patterns, `const TODOS = [...]`
    // matched the `TODO` prefix and produced a false todo-in-code finding.
    const findings = scanPatternsRegex([
      { filename: 'src/list.js', patch: buildPatch(['const TODOS = [1, 2, 3];']) },
      { filename: 'src/list2.js', patch: buildPatch(['let FIXMES_COUNT = 0;']) },
    ]);
    expect(findings.find((f) => f.rule === 'astgrep:todo-in-code')).toBeUndefined();
    expect(findings.find((f) => f.rule === 'astgrep:fixme-in-code')).toBeUndefined();

    // Real markers still fire.
    const findings2 = scanPatternsRegex([
      { filename: 'src/x.js', patch: buildPatch(['// TODO fix']) },
    ]);
    expect(findings2.find((f) => f.rule === 'astgrep:todo-in-code')).toBeTruthy();
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
    // W16-B3-2: updated to the REAL 0.34.3 output shape — `lines` is the
    // matched text (string) and the line lives in range.start.line (0-based).
    const f = mapAstGrepFinding(
      {
        text: 'eval("alert(1)")',
        file: 'src/foo.js',
        lines: 'eval("alert(1)")',
        range: { start: { line: 41, column: 3, index: 84 }, end: { line: 41, column: 17, index: 98 } },
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

  // W16-B3-2: real ast-grep 0.34.3 emits `lines` as a STRING (the matched
  // text) and the 0-based line under `range.start.line`. The old code read
  // `m.lines.start` → undefined → line:null for EVERY real-binary finding,
  // and the file:line:rule dedup then collapsed distinct matches.
  it('reads the line from range.start.line (+1, 0-based) with real-binary shape [W16-B3-2]', () => {
    const f = mapAstGrepFinding({
      text: 'eval(x);',
      file: 'src/foo.js',
      lines: 'eval(x);', // REAL ast-grep: the matched text, NOT a line range
      range: { start: { line: 2, column: 5, index: 40 }, end: { line: 2, column: 13, index: 48 } },
      ruleId: 'eval',
    });
    expect(f.line).toBe(3); // 0-based 2 → 1-based 3
  });

  it('range.start.line takes precedence over legacy numeric lines.start [W16-B3-2]', () => {
    const f = mapAstGrepFinding({
      text: 'eval(x);',
      file: 'a.js',
      lines: { start: 99 }, // legacy fake shape — must NOT win over range
      range: { start: { line: 0 } },
    });
    expect(f.line).toBe(1);
  });

  it('falls back to legacy numeric lines.start when range is absent [W16-B3-2]', () => {
    const f = mapAstGrepFinding({ text: 'x', file: 'a.js', lines: { start: 42 } });
    expect(f.line).toBe(42);
  });

  it('line → null when neither range.start.line nor numeric lines.start exists [W16-B3-2]', () => {
    const f = mapAstGrepFinding({ text: 'x', file: 'a.js', lines: 'the matched text' });
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

  it('parses REAL ast-grep output shape (lines=string, range.start.line 0-based) [W16-B3-2]', () => {
    const json = JSON.stringify([
      {
        text: 'eval(x);',
        file: 'a.js',
        lines: 'eval(x);',
        range: { start: { line: 4, column: 0, index: 80 }, end: { line: 4, column: 8, index: 88 } },
        ruleId: 'eval',
      },
    ]);
    const findings = parseAstGrepJson(json);
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(5);
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
    // finding. The orchestrator calls runBinary once per (rule, language)
    // pair where the language is declared by the rule AND present in the
    // changed files.
    const fakeRunBinary = vi.fn().mockImplementation((path, args) => {
      const patternIdx = args.indexOf('--pattern');
      const pattern = patternIdx >= 0 ? args[patternIdx + 1] : '';
      if (pattern.includes('$$') || pattern.includes('eval')) {
        // Match the eval rule's pattern.
        if (pattern.startsWith('eval')) {
          // W16-B3-1/B3-2: REAL binary shape — the file path is ABSOLUTE
          // (ast-grep echoes the absolute <source> argument) and the line is
          // 0-based under range.start.line.
          return Promise.resolve(
            JSON.stringify([
              {
                text: 'eval("alert(1)")',
                file: '/repo/src/foo.js',
                lines: 'eval("alert(1)")',
                range: { start: { line: 41, column: 0, index: 0 }, end: { line: 41, column: 15, index: 15 } },
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
      {
        files: [{ filename: 'src/foo.js', patch: buildPatch(['const x = 1;']) }],
        repoPath: '/repo',
        cacheDir: '/cache',
      },
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
    // runBinary invoked once per (non-`*` rule, needed language) pair — the
    // only changed file is src/foo.js → only `js` is needed.
    const needed = new Set(['js']);
    const expectedInvocations = DEFAULT_PATTERN_RULES.reduce(
      (n, r) =>
        Array.isArray(r.languages) && !r.languages.includes('*')
          ? n + r.languages.filter((l) => needed.has(l)).length
          : n,
      0,
    );
    expect(expectedInvocations).toBeGreaterThan(0);
    expect(fakeRunBinary).toHaveBeenCalledTimes(expectedInvocations);
    const args = fakeRunBinary.mock.calls[0][1];
    expect(args).toContain('run');
    expect(args).toContain('--json');
  });

  it('drops ast-grep findings for files NOT in the PR changed set [W15-A5-1]', async () => {
    // ast-grep runs over the whole repo tree — a pre-existing issue in an
    // untouched file must not surface as a finding on this PR (wrong lines,
    // and it can crowd out real same-titled findings downstream).
    const fakeRunBinary = vi.fn().mockImplementation((path, args) => {
      const patternIdx = args.indexOf('--pattern');
      const pattern = patternIdx >= 0 ? args[patternIdx + 1] : '';
      if (pattern.startsWith('eval')) {
        // W16-B3-1: absolute path (real binary shape) under a DIFFERENT
        // relative location than any changed file → must be dropped.
        return Promise.resolve(
          JSON.stringify([
            {
              text: 'eval("boom")',
              file: '/repo/legacy/old.js',
              lines: 'eval("boom")',
              range: { start: { line: 2, column: 0, index: 0 }, end: { line: 2, column: 11, index: 11 } },
            },
          ]),
        );
      }
      return Promise.resolve('[]');
    });
    const result = await scanPatterns(
      {
        files: [{ filename: 'src/new.js', patch: buildPatch(['const x = 1;']) }],
        repoPath: '/repo',
      },
      {
        ensureBinary: vi.fn().mockResolvedValue('/p'),
        runBinary: fakeRunBinary,
        platform: 'linux',
        arch: 'x64',
      },
    );
    expect(result.scanner).toBe('ast-grep');
    expect(result.findings).toEqual([]);
  });

  it('keeps ast-grep findings for files that ARE in the PR changed set [W15-A5-1]', async () => {
    const fakeRunBinary = vi.fn().mockImplementation((path, args) => {
      const patternIdx = args.indexOf('--pattern');
      const pattern = patternIdx >= 0 ? args[patternIdx + 1] : '';
      if (pattern.startsWith('eval')) {
        // W16-B3-1: absolute path (real binary shape) under the changed file.
        return Promise.resolve(
          JSON.stringify([
            {
              text: 'eval("boom")',
              file: '/repo/src/new.js',
              lines: 'eval("boom")',
              range: { start: { line: 2, column: 0, index: 0 }, end: { line: 2, column: 11, index: 11 } },
            },
          ]),
        );
      }
      return Promise.resolve('[]');
    });
    const result = await scanPatterns(
      {
        files: [{ filename: 'src/new.js', patch: buildPatch(['const x = 1;']) }],
        repoPath: '/repo',
      },
      {
        ensureBinary: vi.fn().mockResolvedValue('/p'),
        runBinary: fakeRunBinary,
        platform: 'linux',
        arch: 'x64',
      },
    );
    expect(result.scanner).toBe('ast-grep');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      file: 'src/new.js',
      line: 3,
      rule: 'astgrep:eval',
    });
  });

  it('runs a multi-language rule once per language present in the changed files [W15-A5-2]', async () => {
    // `const lang = rule.languages[0]` only ever ran `js`, so .ts files were
    // never scanned by the binary path. Now the rule runs for each language
    // it declares that a changed file actually needs.
    const rules = [
      {
        id: 'eval',
        pattern: 'eval($$$ARGS)',
        severity: 'high',
        category: 'security',
        languages: ['js', 'ts'],
        title: 'Use of eval()',
      },
    ];
    const fakeRunBinary = vi.fn().mockResolvedValue(
      // W16-B3-1/B3-2: real binary shape — absolute file, 0-based range line.
      JSON.stringify([
        {
          text: 'eval(x)',
          file: '/r/src/a.ts',
          lines: 'eval(x)',
          range: { start: { line: 6, column: 0, index: 0 }, end: { line: 6, column: 7, index: 7 } },
        },
      ]),
    );
    const result = await scanPatterns(
      {
        files: [{ filename: 'src/a.ts', patch: buildPatch(['const y = 2;']) }],
        repoPath: '/r',
        rules,
      },
      {
        ensureBinary: vi.fn().mockResolvedValue('/p'),
        runBinary: fakeRunBinary,
        platform: 'linux',
        arch: 'x64',
      },
    );
    expect(result.scanner).toBe('ast-grep');
    expect(fakeRunBinary).toHaveBeenCalledTimes(1);
    const args = fakeRunBinary.mock.calls[0][1];
    expect(args[args.indexOf('--lang') + 1]).toBe('ts');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      file: 'src/a.ts',
      line: 7,
      rule: 'astgrep:eval',
    });
    // F-RULEINDEX pin: `ast-grep run` output carries no ruleId, so severity
    // and title must come from the driver-owned inline enrichment (the custom
    // rule), NOT from mapAstGrepFinding's 'match' fallback ('medium' /
    // 'ast-grep rule "match" matched').
    expect(result.findings[0].severity).toBe('high');
    expect(result.findings[0].title).toBe('Use of eval()');
  });

  it('runs ONLY the languages present in the changed files (js-only diff) [W15-A5-2]', async () => {
    const rules = [
      {
        id: 'eval',
        pattern: 'eval($$$ARGS)',
        severity: 'high',
        category: 'security',
        languages: ['js', 'ts', 'jsx', 'tsx'],
        title: 'Use of eval()',
      },
    ];
    const fakeRunBinary = vi.fn().mockResolvedValue('[]');
    await scanPatterns(
      {
        files: [{ filename: 'src/a.js', patch: buildPatch(['const y = 2;']) }],
        repoPath: '/r',
        rules,
      },
      {
        ensureBinary: vi.fn().mockResolvedValue('/p'),
        runBinary: fakeRunBinary,
        platform: 'linux',
        arch: 'x64',
      },
    );
    expect(fakeRunBinary).toHaveBeenCalledTimes(1);
    const args = fakeRunBinary.mock.calls[0][1];
    expect(args[args.indexOf('--lang') + 1]).toBe('js');
  });

  it('keeps *-language rule findings on the binary success path [W15-A5-3]', async () => {
    // TODO/FIXME rules are skipped in the ast-grep loop (ast-grep `run`
    // requires a concrete --lang). Previously their findings vanished entirely
    // whenever the binary worked — the success path returned ONLY binary
    // findings. Their diff-scoped regex findings must be appended.
    const fakeRunBinary = vi.fn().mockResolvedValue('[]');
    const result = await scanPatterns(
      {
        files: [{ filename: 'src/x.js', patch: buildPatch(['// TODO fix later']) }],
        repoPath: '/r',
      },
      {
        ensureBinary: vi.fn().mockResolvedValue('/p'),
        runBinary: fakeRunBinary,
        platform: 'linux',
        arch: 'x64',
      },
    );
    expect(result.scanner).toBe('ast-grep');
    const todo = result.findings.find((f) => f.rule === 'astgrep:todo-in-code');
    expect(todo).withContext('*-rule findings must survive the binary path').toBeTruthy();
  });

  it('does not fabricate *-rule findings when the diff has no TODO [W15-A5-3]', async () => {
    const fakeRunBinary = vi.fn().mockResolvedValue('[]');
    const result = await scanPatterns(
      {
        files: [{ filename: 'src/x.js', patch: buildPatch(['const x = 1;']) }],
        repoPath: '/r',
      },
      {
        ensureBinary: vi.fn().mockResolvedValue('/p'),
        runBinary: fakeRunBinary,
        platform: 'linux',
        arch: 'x64',
      },
    );
    expect(result.scanner).toBe('ast-grep');
    expect(result.findings.find((f) => f.rule === 'astgrep:todo-in-code')).toBeUndefined();
  });
});

// W16-B3-1: production passes repoPath = process.cwd() (absolute) and runs
// `ast-grep ... <ABS_PATH>` with cwd: source. The REAL binary then emits
// ABSOLUTE file paths in its JSON, while changedFileNames(files) holds
// repo-relative GitHub filenames — the old changedFiles.has(f.file) filter
// never matched, dropping EVERY binary-path finding (and because the run
// still "succeeded", the regex fallback never fired either). Findings' file
// paths must be normalized (path.relative + posix separators) before the
// changed-files filter.
describe('scanPatterns — absolute ast-grep output paths [W16-B3-1]', () => {
  // Real-binary shape: absolute file path, lines = matched text (string),
  // 0-based line in range.start.line.
  const realShapeMatch = (file, line0) => ({
    text: 'eval("boom")',
    file,
    lines: 'eval("boom")',
    range: { start: { line: line0, column: 0, index: 0 }, end: { line: line0, column: 11, index: 11 } },
    ruleId: 'eval',
  });

  const makeDeps = (matchesByPattern) => ({
    ensureBinary: vi.fn().mockResolvedValue('/p'),
    platform: 'linux',
    arch: 'x64',
    runBinary: vi.fn().mockImplementation((_path, args) => {
      const patternIdx = args.indexOf('--pattern');
      const pattern = patternIdx >= 0 ? args[patternIdx + 1] : '';
      const matches = matchesByPattern[pattern] || [];
      return Promise.resolve(JSON.stringify(matches));
    }),
  });

  it('keeps a finding whose file is ABSOLUTE under source and normalizes it [W16-B3-1]', async () => {
    const deps = makeDeps({ 'eval($$$ARGS)': [realShapeMatch('/repo/src/foo.js', 41)] });
    const result = await scanPatterns(
      {
        files: [{ filename: 'src/foo.js', patch: buildPatch(['const x = 1;']) }],
        repoPath: '/repo',
      },
      deps,
    );
    expect(result.scanner).toBe('ast-grep');
    expect(result.findings).toHaveLength(1);
    // The returned finding must carry the repo-RELATIVE name (downstream
    // inline-comment anchoring matches GitHub patch filenames).
    expect(result.findings[0].file).toBe('src/foo.js');
    expect(result.findings[0].line).toBe(42); // 0-based 41 → 1-based 42
    expect(result.findings[0].rule).toBe('astgrep:eval');
  });

  it('still keeps a finding whose file is ALREADY repo-relative [W16-B3-1]', async () => {
    const deps = makeDeps({ 'eval($$$ARGS)': [realShapeMatch('src/foo.js', 41)] });
    const result = await scanPatterns(
      {
        files: [{ filename: 'src/foo.js', patch: buildPatch(['const x = 1;']) }],
        repoPath: '/repo',
      },
      deps,
    );
    expect(result.scanner).toBe('ast-grep');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].file).toBe('src/foo.js');
  });

  it('drops an ABSOLUTE finding whose relative path is NOT in the changed set [W16-B3-1]', async () => {
    const deps = makeDeps({
      'eval($$$ARGS)': [realShapeMatch('/repo/legacy/old.js', 2)],
    });
    const result = await scanPatterns(
      {
        files: [{ filename: 'src/new.js', patch: buildPatch(['const x = 1;']) }],
        repoPath: '/repo',
      },
      deps,
    );
    expect(result.scanner).toBe('ast-grep');
    expect(result.findings).toEqual([]);
  });

  it('drops an ABSOLUTE finding outside source entirely (no relative match) [W16-B3-1]', async () => {
    const deps = makeDeps({
      'eval($$$ARGS)': [realShapeMatch('/elsewhere/other/x.js', 0)],
    });
    const result = await scanPatterns(
      {
        files: [{ filename: 'x.js', patch: buildPatch(['const x = 1;']) }],
        repoPath: '/repo',
      },
      deps,
    );
    expect(result.scanner).toBe('ast-grep');
    expect(result.findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// W17-C1-5: normalizeFindingFilePath's outside-source guard
// `rel.startsWith('..')` also caught legitimate IN-REPO paths that merely
// START with '..' (e.g. '/repo/..hidden/x.js' → rel '..hidden/x.js'): the
// function returned the unmatchable absolute path, so the finding was
// dropped by the changed-files filter. Only a true parent traversal — '..'
// itself or a '../' prefix — is outside the source tree.
// ---------------------------------------------------------------------------
describe('normalizeFindingFilePath — ".."-prefixed in-repo paths [W17-C1-5]', () => {
  it("normalizes an in-repo path starting with '..' to itself", () => {
    expect(normalizeFindingFilePath('/repo/..hidden/x.js', '/repo')).toBe('..hidden/x.js');
  });

  it('returns the raw path for a file outside source', () => {
    expect(normalizeFindingFilePath('/tmp/x.js', '/repo')).toBe('/tmp/x.js');
  });

  it("returns the raw path for a '../' traversal outside source", () => {
    expect(normalizeFindingFilePath('/repo/../../etc/x', '/repo')).toBe('/repo/../../etc/x');
  });

  it('keeps normalizing ordinary in-repo and already-relative paths', () => {
    expect(normalizeFindingFilePath('/repo/src/foo.js', '/repo')).toBe('src/foo.js');
    expect(normalizeFindingFilePath('src/foo.js', '/repo')).toBe('src/foo.js');
  });
});

describe('scanPatterns — absolute in-repo path starting with ".." [W17-C1-5]', () => {
  it('keeps the finding and normalizes the file to "..hidden/x.js"', async () => {
    const deps = {
      ensureBinary: vi.fn().mockResolvedValue('/p'),
      platform: 'linux',
      arch: 'x64',
      runBinary: vi.fn().mockImplementation((_path, args) => {
        const patternIdx = args.indexOf('--pattern');
        const pattern = patternIdx >= 0 ? args[patternIdx + 1] : '';
        const matches =
          pattern === 'eval($$$ARGS)'
            ? [
                {
                  text: 'eval("boom")',
                  file: '/repo/..hidden/x.js',
                  lines: 'eval("boom")',
                  range: {
                    start: { line: 41, column: 0, index: 0 },
                    end: { line: 41, column: 11, index: 11 },
                  },
                  ruleId: 'eval',
                },
              ]
            : [];
        return Promise.resolve(JSON.stringify(matches));
      }),
    };
    const result = await scanPatterns(
      {
        files: [{ filename: '..hidden/x.js', patch: buildPatch(['const x = 1;']) }],
        repoPath: '/repo',
      },
      deps,
    );
    expect(result.scanner).toBe('ast-grep');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].file).toBe('..hidden/x.js');
  });
});

// W16-B3-2: with the line now read from range.start.line, the file:line:rule
// dedup must NOT collapse multiple DISTINCT matches of one rule in one file.
describe('scanPatterns — distinct matches survive dedup (real shape) [W16-B3-2]', () => {
  it('three distinct matches at range lines 0/2/4 → three findings', async () => {
    const rules = [
      {
        id: 'eval',
        pattern: 'eval($$$ARGS)',
        severity: 'high',
        category: 'security',
        languages: ['js'],
        title: 'Use of eval()',
      },
    ];
    const matches = [0, 2, 4].map((line0) => ({
      text: 'eval(x);',
      file: '/r/src/a.js',
      lines: 'eval(x);',
      range: { start: { line: line0, column: 0, index: 0 }, end: { line: line0, column: 8, index: 8 } },
      ruleId: 'eval',
    }));
    const result = await scanPatterns(
      {
        files: [{ filename: 'src/a.js', patch: buildPatch(['const y = 2;']) }],
        repoPath: '/r',
        rules,
      },
      {
        ensureBinary: vi.fn().mockResolvedValue('/p'),
        runBinary: vi.fn().mockResolvedValue(JSON.stringify(matches)),
        platform: 'linux',
        arch: 'x64',
      },
    );
    expect(result.scanner).toBe('ast-grep');
    expect(result.findings).toHaveLength(3);
    expect(result.findings.map((f) => f.line).sort((a, b) => a - b)).toEqual([1, 3, 5]);
    // All three share file+rule; only the line differs — the dedup key must
    // keep them distinct.
    expect(new Set(result.findings.map((f) => `${f.file}:${f.line}:${f.rule}`)).size).toBe(3);
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
    // W15-A5-1: a changed file is required for any rule to run (the binary
    // path is scoped to the diff); benign patch so only the parse path fires.
    const result = await scanPatterns(
      {
        files: [{ filename: 'a.js', patch: buildPatch(['const x = 1;']) }],
        repoPath: '/r',
      },
      {
        ensureBinary: vi.fn().mockResolvedValue('/p'),
        runBinary: vi.fn().mockResolvedValue('not json'),
        platform: 'linux',
        arch: 'x64',
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
