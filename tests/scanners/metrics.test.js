/**
 * Tests for the deterministic diff-metrics scanner (src/lib/scanners/metrics.js).
 *
 * The module is pure (no I/O) — fully unit-testable without binaries, network,
 * or filesystem access.
 */
import { describe, it, expect } from 'vitest';
import {
  computeMetrics,
  formatMetricsForPrompt,
  metricsToFindings,
  isTestFile,
  isSourceFile,
  isGeneratedFile,
  countTodosInPatch,
} from '../../src/lib/scanners/metrics.js';

describe('isTestFile', () => {
  it('classifies *.test.* files as tests', () => {
    expect(isTestFile('foo.test.js')).toBe(true);
    expect(isTestFile('src/lib/foo.test.ts')).toBe(true);
    expect(isTestFile('foo.test.jsx')).toBe(true);
  });

  it('classifies *.spec.* files as tests', () => {
    expect(isTestFile('foo.spec.js')).toBe(true);
    expect(isTestFile('src/foo.spec.tsx')).toBe(true);
  });

  it('classifies __tests__/* files as tests', () => {
    expect(isTestFile('__tests__/foo.js')).toBe(true);
    expect(isTestFile('src/__tests__/foo.test.js')).toBe(true);
  });

  it('classifies tests/* and test/* as tests', () => {
    expect(isTestFile('tests/foo.js')).toBe(true);
    expect(isTestFile('test/foo.js')).toBe(true);
    expect(isTestFile('src/tests/integration/x.js')).toBe(true);
  });

  it('does NOT classify source files as tests', () => {
    expect(isTestFile('src/index.js')).toBe(false);
    expect(isTestFile('lib/foo.py')).toBe(false);
  });

  it('handles bad input', () => {
    expect(isTestFile('')).toBe(false);
    expect(isTestFile(null)).toBe(false);
    expect(isTestFile(undefined)).toBe(false);
  });
});

describe('isSourceFile', () => {
  it('classifies recognized source extensions as source', () => {
    expect(isSourceFile('src/index.js')).toBe(true);
    expect(isSourceFile('src/index.ts')).toBe(true);
    expect(isSourceFile('src/app.tsx')).toBe(true);
    expect(isSourceFile('lib/foo.py')).toBe(true);
    expect(isSourceFile('cmd/main.go')).toBe(true);
    expect(isSourceFile('config.yml')).toBe(true);
    expect(isSourceFile('package.json')).toBe(true);
  });

  it('does NOT classify test files as source', () => {
    expect(isSourceFile('foo.test.js')).toBe(false);
    expect(isSourceFile('tests/integration/x.js')).toBe(false);
  });

  it('does NOT classify unknown extensions', () => {
    expect(isSourceFile('README.md')).toBe(false);
    expect(isSourceFile('logo.png')).toBe(false);
    expect(isSourceFile('edge.cjs')).toBe(true); // cjs IS in the table
  });
});

describe('isGeneratedFile', () => {
  it('classifies lockfiles as generated', () => {
    expect(isGeneratedFile('package-lock.json')).toBe(true);
    expect(isGeneratedFile('yarn.lock')).toBe(true);
    expect(isGeneratedFile('pnpm-lock.yaml')).toBe(true);
    expect(isGeneratedFile('foo.lock')).toBe(true);
    expect(isGeneratedFile('src/foo.lock')).toBe(true);
  });

  it('classifies .generated.* files as generated', () => {
    expect(isGeneratedFile('foo.generated.js')).toBe(true);
    expect(isGeneratedFile('src/parser.generated.ts')).toBe(true);
  });

  it('classifies dist/* and build/* as generated', () => {
    expect(isGeneratedFile('dist/index.js')).toBe(true);
    expect(isGeneratedFile('build/lib/foo.js')).toBe(true);
  });

  it('classifies .min.* files as generated', () => {
    expect(isGeneratedFile('jquery.min.js')).toBe(true);
  });

  it('does NOT classify regular source files', () => {
    expect(isGeneratedFile('src/index.js')).toBe(false);
    expect(isGeneratedFile('package.json')).toBe(false);
  });
});

describe('countTodosInPatch', () => {
  it('counts TODO markers in added lines', () => {
    const patch = [
      '@@ -1,2 +1,3 @@',
      ' context line',
      '-removed line',
      '+// TODO: fix this',
      '+// FIXME: later',
      '+console.log(x)',
    ].join('\n');
    expect(countTodosInPatch(patch)).toBe(2);
  });

  it('counts HACK and XXX markers too', () => {
    const patch = [
      '@@ -1,2 +1,3 @@',
      '+// HACK: workaround',
      '+// XXX: ugly',
    ].join('\n');
    expect(countTodosInPatch(patch)).toBe(2);
  });

  it('does NOT count XXX as a substring of larger words (word-boundary match)', () => {
    // `XXXL` and `XXXY` are NOT TODO markers (XXX glued to other word chars);
    // only a standalone `XXX` (with word boundaries) should count.
    const patch = [
      '@@ -1,2 +1,3 @@',
      '+const size = "XXXL"', // clothing size — not a marker
      '+const code = "XXXY"', // not a marker
    ].join('\n');
    expect(countTodosInPatch(patch)).toBe(0);
  });

  it('still counts a real XXX marker with word boundaries', () => {
    // A genuine `// XXX:` comment must still register.
    expect(countTodosInPatch('@@ -1,1 +1,1 @@\n+// XXX: ugly hack')).toBe(1);
    expect(countTodosInPatch('@@ -1,1 +1,1 @@\n+// XXX hack here')).toBe(1);
  });

  it('counts only ONE per line even with multiple markers', () => {
    const patch = '@@ -1,1 +1,1 @@\n+// TODO and FIXME both here';
    expect(countTodosInPatch(patch)).toBe(1);
  });

  it('skips removed (–) and context (space) lines', () => {
    const patch = [
      '@@ -1,3 +1,3 @@',
      '-// TODO: in removed line',
      ' // FIXME: in context line',
      '+// HACK: real added marker',
    ].join('\n');
    expect(countTodosInPatch(patch)).toBe(1); // only the HACK on a `+` line counts
  });

  it('skips the +++ file header', () => {
    const patch = [
      '@@ -1,1 +1,2 @@',
      '+++ b/foo.js',
      '+// TODO: real todo',
    ].join('\n');
    expect(countTodosInPatch(patch)).toBe(1);
  });

  // SCN-16: a `+` line that appears BEFORE any hunk header is diff metadata,
  // not an added line — parseAddedLines skips pre-hunk lines, so the TODO
  // counter must not count it.
  it('does NOT count a TODO on a pre-hunk + line', () => {
    const patch = [
      '+// TODO: this is in the diff metadata, not a real hunk',
      '@@ -1,1 +1,1 @@',
      ' context',
      '+// FIXME: real added marker',
    ].join('\n');
    expect(countTodosInPatch(patch)).toBe(1);
  });

  it('handles empty / invalid input', () => {
    expect(countTodosInPatch('')).toBe(0);
    expect(countTodosInPatch(null)).toBe(0);
    expect(countTodosInPatch(undefined)).toBe(0);
  });
});

describe('computeMetrics', () => {
  it('returns a zero-shaped result for empty input', () => {
    const m = computeMetrics([]);
    expect(m.filesChanged).toBe(0);
    expect(m.additions).toBe(0);
    expect(m.deletions).toBe(0);
    expect(m.testFiles).toBe(0);
    expect(m.sourceFiles).toBe(0);
    expect(m.testToSourceRatio).toBe(0);
    expect(m.largeFiles).toEqual([]);
    expect(m.generatedFiles).toEqual([]);
    expect(m.todoCount).toBe(0);
    expect(m.byStatus).toEqual({});
  });

  it('handles non-array input safely', () => {
    expect(computeMetrics(null)).toEqual({
      filesChanged: 0,
      additions: 0,
      deletions: 0,
      testFiles: 0,
      sourceFiles: 0,
      testToSourceRatio: 0,
      largeFiles: [],
      generatedFiles: [],
      todoCount: 0,
      byStatus: {},
    });
    // @ts-expect-error - testing bad input
    expect(computeMetrics('foo').filesChanged).toBe(0);
  });

  it('sums additions/deletions/changes', () => {
    const m = computeMetrics([
      { filename: 'a.js', additions: 10, deletions: 2 },
      { filename: 'b.js', additions: 5, deletions: 1 },
    ]);
    expect(m.additions).toBe(15);
    expect(m.deletions).toBe(3);
  });

  it('treats missing numerics as 0', () => {
    const m = computeMetrics([{ filename: 'a.js' }]);
    expect(m.additions).toBe(0);
    expect(m.deletions).toBe(0);
  });

  it('treats non-finite numerics as 0', () => {
    const m = computeMetrics([
      { filename: 'a.js', additions: NaN, deletions: Infinity },
    ]);
    expect(m.additions).toBe(0);
    expect(m.deletions).toBe(0);
  });

  it('classifies test vs source files', () => {
    const m = computeMetrics([
      { filename: 'src/foo.js' }, // source
      { filename: 'src/foo.test.js' }, // test
      { filename: 'tests/x.js' }, // test
      { filename: 'README.md' }, // neither
    ]);
    expect(m.sourceFiles).toBe(1);
    expect(m.testFiles).toBe(2);
  });

  it('computes test-to-source ratio (testFiles / sourceFiles)', () => {
    const m = computeMetrics([
      { filename: 'src/foo.js' }, // source
      { filename: 'src/foo.test.js' }, // test
      { filename: 'src/bar.test.js' }, // test
    ]);
    // 2 test / 1 source = 2
    expect(m.testToSourceRatio).toBeCloseTo(2, 5);
  });

  it('returns ratio 0 when no source files', () => {
    const m = computeMetrics([{ filename: 'src/foo.test.js' }]);
    expect(m.testToSourceRatio).toBe(0);
  });

  it('flags large files (>300 changes)', () => {
    const m = computeMetrics([
      { filename: 'big.js', changes: 301 },
      { filename: 'small.js', changes: 300 }, // boundary NOT large
      { filename: 'tiny.js', changes: 50 },
    ]);
    expect(m.largeFiles).toEqual(['big.js']);
  });

  it('uses additions+deletions when changes missing for large-file detection', () => {
    const m = computeMetrics([
      { filename: 'big.js', additions: 200, deletions: 200 }, // 400 > 300
    ]);
    expect(m.largeFiles).toEqual(['big.js']);
  });

  it('flags generated files', () => {
    const m = computeMetrics([
      { filename: 'package-lock.json' },
      { filename: 'src/index.js' },
      { filename: 'dist/bundle.js' },
    ]);
    expect(m.generatedFiles).toEqual(['package-lock.json', 'dist/bundle.js']);
  });

  it('counts TODOs across patches', () => {
    const m = computeMetrics([
      { filename: 'a.js', patch: '@@ -1,1 +1,2 @@\n+// TODO: a\n+// FIXME: a2' },
      { filename: 'b.js', patch: '@@ -1,2 +1,2 @@\n context\n-// TODO removed\n+// TODO: b' },
    ]);
    expect(m.todoCount).toBe(3); // a + a2 + b
  });

  it('aggregates by status', () => {
    const m = computeMetrics([
      { filename: 'a.js', status: 'added' },
      { filename: 'b.js', status: 'modified' },
      { filename: 'c.js', status: 'modified' },
      { filename: 'd.js', status: 'removed' },
    ]);
    expect(m.byStatus).toEqual({ added: 1, modified: 2, removed: 1 });
  });

  it('defaults missing status to modified', () => {
    const m = computeMetrics([{ filename: 'a.js' }]);
    expect(m.byStatus).toEqual({ modified: 1 });
  });

  it('skips entries with no filename', () => {
    const m = computeMetrics([
      { filename: 'a.js' },
      // @ts-expect-error - missing filename
      { additions: 5 },
      null,
    ]);
    expect(m.filesChanged).toBe(1);
  });
});

describe('formatMetricsForPrompt', () => {
  it('formats a single-file PR', () => {
    const m = computeMetrics([{ filename: 'a.js', additions: 10, deletions: 2 }]);
    const s = formatMetricsForPrompt(m);
    expect(s).toBe('1 files (+10 -2), test-to-source ratio 0.00, 0 large files, 0 TODOs.');
  });

  it('pluralizes "files" vs "file" and "TODOs" vs "TODO"', () => {
    const m1 = computeMetrics([
      { filename: 'a.js', patch: '@@ -1,1 +1,1 @@\n+// TODO: x' },
    ]);
    expect(formatMetricsForPrompt(m1)).toContain('1 files');
    expect(formatMetricsForPrompt(m1)).toContain('1 TODO.');
  });

  it('includes large file count', () => {
    const m = computeMetrics([{ filename: 'big.js', changes: 500 }]);
    const s = formatMetricsForPrompt(m);
    expect(s).toContain('1 large file,');
  });

  it('handles bad input', () => {
    expect(formatMetricsForPrompt(null)).toBe('');
    expect(formatMetricsForPrompt(undefined)).toBe('');
  });
});

describe('metricsToFindings', () => {
  it('emits an info finding for each large file', () => {
    const m = computeMetrics([{ filename: 'big.js', changes: 500 }]);
    const findings = metricsToFindings(m);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: 'big.js',
      severity: 'info',
      confidence: 'high',
      category: 'maintainability',
      rule: 'metrics:large-file',
    });
  });

  it('emits an info finding for each generated file', () => {
    const m = computeMetrics([{ filename: 'package-lock.json' }]);
    const findings = metricsToFindings(m);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: 'package-lock.json',
      severity: 'info',
      confidence: 'high',
      category: 'maintainability',
      rule: 'metrics:generated-file',
    });
  });

  it('returns empty for a clean PR', () => {
    const m = computeMetrics([{ filename: 'foo.js', additions: 5 }]);
    expect(metricsToFindings(m)).toEqual([]);
  });

  it('handles bad input', () => {
    expect(metricsToFindings(null)).toEqual([]);
    expect(metricsToFindings(undefined)).toEqual([]);
  });
});
