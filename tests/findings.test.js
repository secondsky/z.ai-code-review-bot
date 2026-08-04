/**
 * Tests for the v2 structured-findings schema module (src/lib/findings.js).
 *
 * The module is pure (no I/O) and is the foundation of the v2 refactor that
 * replaces free-form markdown reviews with a strict structured-findings schema.
 * Coverage:
 *   - validateFinding: per-field validation, missing/extra fields, case coercion
 *   - normalizeFinding: title truncation, rule default, extra-field stripping
 *   - parseFindings: tolerant JSON extraction, anti-hallucination filter, dedup
 *   - rankAndCapFindings: severity/confidence/file/line sort, minSeverity, cap
 *   - mergeFindings: deterministic-supersedes-LLM at same key
 *   - formatFindingsAsSummary: header, severity emojis, empty state, marker
 */
import { describe, it, expect } from 'vitest';
import {
  SEVERITIES,
  CONFIDENCES,
  CATEGORIES,
  SEVERITY_RANK,
  validateFinding,
  normalizeFinding,
  parseFindings,
  rankAndCapFindings,
  mergeFindings,
  formatFindingsAsSummary,
} from '../src/lib/findings.js';

/** A fully valid finding used as the base for mutations in tests. */
const validFinding = () => ({
  file: 'src/index.js',
  line: 42,
  severity: 'high',
  confidence: 'medium',
  category: 'bug',
  title: 'Possible null dereference',
  description: 'The variable may be null when used here.',
  evidence: 'const x = obj.value;',
  suggestion: 'Guard with `if (obj)`.',
  rule: 'llm',
});

describe('constants', () => {
  it('exports the allowed-value arrays verbatim', () => {
    expect(SEVERITIES).toEqual(['critical', 'high', 'medium', 'low', 'info']);
    expect(CONFIDENCES).toEqual(['high', 'medium', 'low']);
    expect(CATEGORIES).toEqual([
      'bug',
      'security',
      'performance',
      'maintainability',
      'style',
      'test',
      'docs',
    ]);
  });

  it('exports the SEVERITY_RANK map verbatim', () => {
    expect(SEVERITY_RANK).toEqual({
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
      info: 4,
    });
  });
});

describe('validateFinding', () => {
  it('accepts a fully valid finding', () => {
    const result = validateFinding(validFinding());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts a file-level finding (line === null)', () => {
    const f = { ...validFinding(), line: null };
    const result = validateFinding(f);
    expect(result.ok).toBe(true);
  });

  it('rejects a missing file', () => {
    const { file, ...rest } = validFinding();
    const result = validateFinding(rest);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/file/i);
  });

  it('rejects an empty-string file', () => {
    const result = validateFinding({ ...validFinding(), file: '' });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/file/i);
  });

  it('rejects a non-positive-integer line', () => {
    expect(validateFinding({ ...validFinding(), line: 0 }).ok).toBe(false);
    expect(validateFinding({ ...validFinding(), line: -3 }).ok).toBe(false);
    expect(validateFinding({ ...validFinding(), line: 1.5 }).ok).toBe(false);
    expect(validateFinding({ ...validFinding(), line: '42' }).ok).toBe(false);
  });

  it('rejects an out-of-range severity', () => {
    const result = validateFinding({ ...validFinding(), severity: 'blocker' });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/severity/i);
  });

  it('coerces severity case-insensitively before validating', () => {
    const result = validateFinding({ ...validFinding(), severity: 'CRITICAL' });
    expect(result.ok).toBe(true);
  });

  it('coerces confidence case-insensitively before validating', () => {
    const result = validateFinding({ ...validFinding(), confidence: 'HIGH' });
    expect(result.ok).toBe(true);
  });

  it('coerces category case-insensitively before validating', () => {
    const result = validateFinding({ ...validFinding(), category: 'SECURITY' });
    expect(result.ok).toBe(true);
  });

  it('rejects an out-of-range confidence', () => {
    const result = validateFinding({ ...validFinding(), confidence: 'certain' });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/confidence/i);
  });

  it('rejects an out-of-range category', () => {
    const result = validateFinding({ ...validFinding(), category: 'architecture' });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/category/i);
  });

  it('rejects an empty title', () => {
    const result = validateFinding({ ...validFinding(), title: '' });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/title/i);
  });

  it('flags a title longer than 120 chars (>120 means >120, not >=)', () => {
    const long = 'x'.repeat(121);
    const result = validateFinding({ ...validFinding(), title: long });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/title/i);
  });

  it('accepts a title of exactly 120 chars', () => {
    const exact = 'x'.repeat(120);
    const result = validateFinding({ ...validFinding(), title: exact });
    expect(result.ok).toBe(true);
  });

  it('rejects an empty description', () => {
    const result = validateFinding({ ...validFinding(), description: '' });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/description/i);
  });

  it('accepts an empty-string evidence', () => {
    const result = validateFinding({ ...validFinding(), evidence: '' });
    expect(result.ok).toBe(true);
  });

  it('accepts null suggestion', () => {
    const result = validateFinding({ ...validFinding(), suggestion: null });
    expect(result.ok).toBe(true);
  });

  it('accepts null rule', () => {
    const result = validateFinding({ ...validFinding(), rule: null });
    expect(result.ok).toBe(true);
  });

  it('ignores extra fields', () => {
    const result = validateFinding({ ...validFinding(), extra: 'ignored', nested: { a: 1 } });
    expect(result.ok).toBe(true);
  });

  it('rejects a non-array suggestion', () => {
    const result = validateFinding({ ...validFinding(), suggestion: ['fix it'] });
    expect(result.ok).toBe(false);
  });
});

describe('normalizeFinding', () => {
  it('case-normalizes severity/confidence/category', () => {
    const out = normalizeFinding({
      ...validFinding(),
      severity: 'CRITICAL',
      confidence: 'HIGH',
      category: 'SECURITY',
    });
    expect(out.severity).toBe('critical');
    expect(out.confidence).toBe('high');
    expect(out.category).toBe('security');
  });

  it('truncates a title longer than 120 chars to 117 + ...', () => {
    const out = normalizeFinding({ ...validFinding(), title: 'x'.repeat(200) });
    expect(out.title).toBe('x'.repeat(117) + '...');
    expect(out.title.length).toBe(120);
  });

  it('leaves a 120-char title untouched', () => {
    const exact = 'y'.repeat(120);
    const out = normalizeFinding({ ...validFinding(), title: exact });
    expect(out.title).toBe(exact);
  });

  it('defaults a null rule to "llm"', () => {
    const out = normalizeFinding({ ...validFinding(), rule: null });
    expect(out.rule).toBe('llm');
  });

  it('preserves a non-null rule verbatim', () => {
    const out = normalizeFinding({ ...validFinding(), rule: 'eslint:no-unused-vars' });
    expect(out.rule).toBe('eslint:no-unused-vars');
  });

  it('drops extra fields and emits exactly the schema keys', () => {
    const out = normalizeFinding({ ...validFinding(), extra: 'ignored', debug: true });
    expect(Object.keys(out).sort()).toEqual(
      [
        'file',
        'line',
        'severity',
        'confidence',
        'category',
        'title',
        'description',
        'evidence',
        'suggestion',
        'rule',
      ].sort(),
    );
    expect(out).not.toHaveProperty('extra');
  });

  it('returns null when validateFinding fails after coercion', () => {
    const out = normalizeFinding({ ...validFinding(), severity: 'definitely-not-real' });
    expect(out).toBeNull();
  });

  it('preserves suggestion: null', () => {
    const out = normalizeFinding({ ...validFinding(), suggestion: null });
    expect(out.suggestion).toBeNull();
  });

  it('preserves evidence: ""', () => {
    const out = normalizeFinding({ ...validFinding(), evidence: '' });
    expect(out.evidence).toBe('');
  });

  it('defaults omitted optional fields (evidence/suggestion/rule)', () => {
    // Destructure off the optionals to simulate the model omitting them.
    const { evidence, suggestion, rule, ...core } = validFinding();
    void evidence;
    void suggestion;
    void rule;
    const out = normalizeFinding(core);
    expect(out).not.toBeNull();
    expect(out.evidence).toBe('');
    expect(out.suggestion).toBeNull();
    expect(out.rule).toBe('llm');
  });
});

describe('parseFindings', () => {
  it('parses a clean JSON array', () => {
    const raw = JSON.stringify([validFinding()]);
    const out = parseFindings(raw, { changedFiles: ['src/index.js'] });
    expect(out).toHaveLength(1);
    expect(out[0].file).toBe('src/index.js');
  });

  it('parses a fenced ```json block surrounded by prose', () => {
    const raw = `Here is my review:\n\n\`\`\`json\n${JSON.stringify([validFinding()])}\n\`\`\`\n\nThanks.`;
    const out = parseFindings(raw, { changedFiles: ['src/index.js'] });
    expect(out).toHaveLength(1);
    expect(out[0].file).toBe('src/index.js');
  });

  it('parses a bare [...] embedded in prose', () => {
    const raw = `Review follows: ${JSON.stringify([validFinding()])} -- end.`;
    const out = parseFindings(raw, { changedFiles: ['src/index.js'] });
    expect(out).toHaveLength(1);
  });

  it('returns [] when there is no JSON at all', () => {
    const raw = 'Just prose, nothing parseable here.';
    expect(parseFindings(raw, { changedFiles: ['src/index.js'] })).toEqual([]);
  });

  it('returns [] on partial/malformed JSON', () => {
    const raw = 'Review: [ { "file": "a", ';
    expect(parseFindings(raw, { changedFiles: ['a'] })).toEqual([]);
  });

  it('returns [] when the parsed JSON is not an array (e.g. an object)', () => {
    const raw = JSON.stringify({ file: 'a', line: 1 });
    expect(parseFindings(raw, { changedFiles: ['a'] })).toEqual([]);
  });

  it('drops findings whose file is not in changedFiles (anti-hallucination)', () => {
    const raw = JSON.stringify([
      { ...validFinding(), file: 'src/index.js' },
      { ...validFinding(), file: 'not-in-diff.js' },
    ]);
    const out = parseFindings(raw, { changedFiles: ['src/index.js'] });
    expect(out).toHaveLength(1);
    expect(out[0].file).toBe('src/index.js');
  });

  it('accepts changedFiles as objects with .filename', () => {
    const raw = JSON.stringify([{ ...validFinding(), file: 'src/index.js' }]);
    const out = parseFindings(raw, {
      changedFiles: [{ filename: 'src/index.js', additions: 1, deletions: 0 }],
    });
    expect(out).toHaveLength(1);
  });

  it('drops findings whose file is absent when changedFiles mixes shapes', () => {
    const raw = JSON.stringify([
      { ...validFinding(), file: 'src/a.js' },
      { ...validFinding(), file: 'src/b.js' },
      { ...validFinding(), file: 'src/c.js' },
    ]);
    const out = parseFindings(raw, {
      changedFiles: ['src/a.js', { filename: 'src/b.js' }],
    });
    expect(out.map((f) => f.file).sort()).toEqual(['src/a.js', 'src/b.js']);
  });

  it('dedups by file:line:title (first occurrence wins)', () => {
    const a = { ...validFinding(), title: 'Duplicate issue' };
    const b = { ...validFinding(), title: 'DUPLICATE ISSUE' }; // case-insensitive
    const c = { ...validFinding(), title: 'Different issue' };
    const raw = JSON.stringify([a, b, c]);
    const out = parseFindings(raw, { changedFiles: ['src/index.js'] });
    expect(out).toHaveLength(2);
    expect(out.map((f) => f.title).sort()).toEqual(['Different issue', 'Duplicate issue']);
  });

  it('dedups treat null line as the literal string "null" in the key', () => {
    const a = { ...validFinding(), line: null, title: 'File-level' };
    const b = { ...validFinding(), line: null, title: 'file-level' };
    const raw = JSON.stringify([a, b]);
    const out = parseFindings(raw, { changedFiles: ['src/index.js'] });
    expect(out).toHaveLength(1);
  });

  it('skips elements that normalizeFinding rejects', () => {
    const raw = JSON.stringify([
      validFinding(),
      { ...validFinding(), severity: 'nope' },
    ]);
    const out = parseFindings(raw, { changedFiles: ['src/index.js'] });
    expect(out).toHaveLength(1);
  });

  it('handles an empty array input string', () => {
    expect(parseFindings('[]', { changedFiles: ['src/index.js'] })).toEqual([]);
  });

  it('returns [] when raw is not a string', () => {
    expect(parseFindings(null, { changedFiles: ['src/index.js'] })).toEqual([]);
    expect(parseFindings(undefined, { changedFiles: ['src/index.js'] })).toEqual([]);
  });

  it('treats missing changedFiles as no files allowed (drops everything)', () => {
    const raw = JSON.stringify([validFinding()]);
    expect(parseFindings(raw)).toEqual([]);
  });

  it('does not throw on a non-array changedFiles', () => {
    const raw = JSON.stringify([validFinding()]);
    expect(parseFindings(raw, { changedFiles: null })).toEqual([]);
    expect(parseFindings(raw, {})).toEqual([]);
  });
});

describe('rankAndCapFindings', () => {
  it('orders by severity ASC (critical first)', () => {
    const findings = [
      { ...validFinding(), severity: 'low' },
      { ...validFinding(), severity: 'critical' },
      { ...validFinding(), severity: 'medium' },
    ];
    const out = rankAndCapFindings(findings);
    expect(out.map((f) => f.severity)).toEqual(['critical', 'medium', 'low']);
  });

  it('uses confidence as a tiebreak (high -> medium -> low)', () => {
    const findings = [
      { ...validFinding(), severity: 'high', confidence: 'low', file: 'a', line: 1 },
      { ...validFinding(), severity: 'high', confidence: 'high', file: 'a', line: 1 },
      { ...validFinding(), severity: 'high', confidence: 'medium', file: 'a', line: 1 },
    ];
    const out = rankAndCapFindings(findings);
    expect(out.map((f) => f.confidence)).toEqual(['high', 'medium', 'low']);
  });

  it('uses file then line as final tiebreaks', () => {
    const findings = [
      { ...validFinding(), severity: 'high', confidence: 'high', file: 'b.js', line: 5 },
      { ...validFinding(), severity: 'high', confidence: 'high', file: 'a.js', line: 9 },
      { ...validFinding(), severity: 'high', confidence: 'high', file: 'a.js', line: 3 },
    ];
    const out = rankAndCapFindings(findings);
    expect(out.map((f) => `${f.file}:${f.line}`)).toEqual(['a.js:3', 'a.js:9', 'b.js:5']);
  });

  it('drops findings below minSeverity', () => {
    const findings = [
      { ...validFinding(), severity: 'critical' },
      { ...validFinding(), severity: 'info' },
      { ...validFinding(), severity: 'low' },
    ];
    const out = rankAndCapFindings(findings, { minSeverity: 'medium' });
    expect(out.map((f) => f.severity)).toEqual(['critical']);
  });

  it('respects maxFindings cap', () => {
    const findings = Array.from({ length: 12 }, (_, i) => ({
      ...validFinding(),
      severity: 'medium',
      file: 'a.js',
      line: i + 1,
    }));
    const out = rankAndCapFindings(findings, { maxFindings: 5 });
    expect(out).toHaveLength(5);
  });

  it('returns an empty array for empty input', () => {
    expect(rankAndCapFindings([])).toEqual([]);
  });

  it('sorts null-line findings after non-null at the same file', () => {
    const findings = [
      { ...validFinding(), severity: 'high', confidence: 'high', file: 'a.js', line: null },
      { ...validFinding(), severity: 'high', confidence: 'high', file: 'a.js', line: 5 },
    ];
    const out = rankAndCapFindings(findings);
    expect(out.map((f) => f.line)).toEqual([5, null]);
  });
});

describe('mergeFindings', () => {
  it('lets a deterministic finding supersede an LLM finding at the same key+title', () => {
    const llm = [{ ...validFinding(), rule: 'llm', title: 'Unused variable' }];
    const det = [
      { ...validFinding(), rule: 'eslint:no-unused-vars', title: 'Unused variable' },
    ];
    const out = mergeFindings(llm, det);
    expect(out).toHaveLength(1);
    expect(out[0].rule).toBe('eslint:no-unused-vars');
  });

  it('supersede is case-insensitive on title', () => {
    const llm = [{ ...validFinding(), rule: 'llm', title: 'Unused Variable' }];
    const det = [
      { ...validFinding(), rule: 'eslint:no-unused-vars', title: 'UNUSED VARIABLE' },
    ];
    const out = mergeFindings(llm, det);
    expect(out).toHaveLength(1);
    expect(out[0].rule).toBe('eslint:no-unused-vars');
  });

  it('keeps both when titles differ at the same file:line', () => {
    const llm = [{ ...validFinding(), rule: 'llm', title: 'Bug A' }];
    const det = [
      { ...validFinding(), rule: 'eslint:no-unused-vars', title: 'Bug B' },
    ];
    const out = mergeFindings(llm, det);
    expect(out).toHaveLength(2);
    const rules = out.map((f) => f.rule).sort();
    expect(rules).toEqual(['eslint:no-unused-vars', 'llm']);
  });

  it('keeps everything when the two sets are disjoint', () => {
    const llm = [{ ...validFinding(), file: 'a.js', line: 1, title: 'A' }];
    const det = [{ ...validFinding(), file: 'b.js', line: 2, title: 'B' }];
    const out = mergeFindings(llm, det);
    expect(out).toHaveLength(2);
  });

  it('treats null-line findings as the "null" key for matching', () => {
    // Same title + same (null) line → deterministic wins.
    const llm = [{ ...validFinding(), line: null, title: 'A', rule: 'llm' }];
    const det = [
      { ...validFinding(), line: null, title: 'A', rule: 'eslint:x' },
    ];
    const out = mergeFindings(llm, det);
    expect(out).toHaveLength(1);
    expect(out[0].rule).toBe('eslint:x');
  });

  it('deterministic wins regardless of input order in arrays', () => {
    const llm = [
      { ...validFinding(), file: 'a.js', line: 1, title: 'A', rule: 'llm' },
      { ...validFinding(), file: 'a.js', line: 1, title: 'A', rule: 'llm' },
    ];
    const det = [
      { ...validFinding(), file: 'a.js', line: 1, title: 'A', rule: 'eslint:no-unused-vars' },
    ];
    const out = mergeFindings(llm, det);
    expect(out).toHaveLength(1);
    expect(out[0].rule).toBe('eslint:no-unused-vars');
  });

  it('handles empty inputs', () => {
    expect(mergeFindings([], [])).toEqual([]);
    expect(mergeFindings([{ ...validFinding() }], [])).toHaveLength(1);
    expect(mergeFindings([], [{ ...validFinding() }])).toHaveLength(1);
  });
});

describe('formatFindingsAsSummary', () => {
  it('renders the header and trailing marker byte-exact', () => {
    const out = formatFindingsAsSummary([]);
    expect(out.startsWith('## Z.ai Code Review\n\n')).toBe(true);
    expect(out.endsWith('\n\n<!-- zai-code-review -->')).toBe(true);
  });

  it('renders the empty-state message when there are no findings', () => {
    const out = formatFindingsAsSummary([]);
    expect(out).toContain('No issues found. The changes look good. ✅');
    // No severity group headers when empty.
    expect(out).not.toMatch(/#### [🔴🟠🟡🔵➖]/);
  });

  it('renders a single finding with the correct severity emoji and structure', () => {
    const out = formatFindingsAsSummary([
      {
        ...validFinding(),
        severity: 'critical',
        title: 'Critical bug',
        description: 'A critical issue.',
        suggestion: 'Fix it.',
        evidence: 'bad = code;',
      },
    ]);
    expect(out).toContain('#### 🔴 Critical (1)');
    expect(out).toContain('- **src/index.js**:L42 — Critical bug');
    expect(out).toContain('A critical issue.');
    expect(out).toContain('💡 Fix it.');
    expect(out).toContain('> `bad = code;`');
  });

  it('omits the suggestion line when suggestion is null', () => {
    const out = formatFindingsAsSummary([
      { ...validFinding(), suggestion: null, evidence: '' },
    ]);
    expect(out).not.toContain('💡');
  });

  it('omits the evidence line when evidence is empty', () => {
    const out = formatFindingsAsSummary([
      { ...validFinding(), suggestion: null, evidence: '' },
    ]);
    // The "> `...`" evidence quote should not be present.
    expect(out).not.toMatch(/^> `/m);
  });

  it('renders file-level findings without the :L suffix when line is null', () => {
    const out = formatFindingsAsSummary([{ ...validFinding(), line: null }]);
    expect(out).toContain('- **src/index.js** — Possible null dereference');
    expect(out).not.toContain(':Lnull');
  });

  it('counts severities correctly in the summary line', () => {
    const out = formatFindingsAsSummary([
      { ...validFinding(), severity: 'critical' },
      { ...validFinding(), severity: 'critical' },
      { ...validFinding(), severity: 'high' },
      { ...validFinding(), severity: 'low' },
    ]);
    expect(out).toContain('4 findings:');
    expect(out).toContain('🔴 2 critical');
    expect(out).toContain('🟠 1 high');
    expect(out).toContain('🔵 1 low');
    expect(out).toContain('🟡 0 medium');
    expect(out).toContain('➖ 0 info');
  });

  it('groups findings under per-severity headers in severity order', () => {
    const out = formatFindingsAsSummary([
      { ...validFinding(), severity: 'low', title: 'L1' },
      { ...validFinding(), severity: 'critical', title: 'C1' },
      { ...validFinding(), severity: 'high', title: 'H1' },
    ]);
    const critIdx = out.indexOf('#### 🔴 Critical');
    const highIdx = out.indexOf('#### 🟠 High');
    const lowIdx = out.indexOf('#### 🔵 Low');
    expect(critIdx).toBeGreaterThan(-1);
    expect(critIdx).toBeLessThan(highIdx);
    expect(highIdx).toBeLessThan(lowIdx);
    // No medium group header since count is 0.
    expect(out).not.toContain('#### 🟡 Medium');
  });

  it('renders the deterministic-findings line only when count > 0', () => {
    const withLine = formatFindingsAsSummary([], {
      metadata: { deterministicFindingsCount: 3 },
    });
    expect(withLine).toContain('🔍 Scanners found 3 deterministic issues.');

    const without = formatFindingsAsSummary([], {
      metadata: { deterministicFindingsCount: 0 },
    });
    expect(without).not.toContain('🔍 Scanners found');

    const undef = formatFindingsAsSummary([]);
    expect(undef).not.toContain('🔍 Scanners found');
  });

  it('renders the truncation note when truncated > 0', () => {
    const out = formatFindingsAsSummary(
      [{ ...validFinding() }],
      { metadata: { truncated: 4 } },
    );
    expect(out).toMatch(/truncated/i);
    expect(out).toContain('4');
  });

  it('omits the truncation note when truncated is 0 or missing', () => {
    const a = formatFindingsAsSummary([{ ...validFinding() }]);
    expect(a).not.toMatch(/truncated/i);

    const b = formatFindingsAsSummary([{ ...validFinding() }], { metadata: { truncated: 0 } });
    expect(b).not.toMatch(/truncated/i);
  });

  it('uses the custom reviewerName when provided', () => {
    const out = formatFindingsAsSummary([], { reviewerName: 'Custom Reviewer' });
    expect(out.startsWith('## Custom Reviewer\n\n')).toBe(true);
  });

  it('uses all five severity emojis correctly', () => {
    const out = formatFindingsAsSummary([
      { ...validFinding(), severity: 'critical', title: 'c' },
      { ...validFinding(), severity: 'high', title: 'h' },
      { ...validFinding(), severity: 'medium', title: 'm' },
      { ...validFinding(), severity: 'low', title: 'l' },
      { ...validFinding(), severity: 'info', title: 'i' },
    ]);
    expect(out).toContain('#### 🔴 Critical (1)');
    expect(out).toContain('#### 🟠 High (1)');
    expect(out).toContain('#### 🟡 Medium (1)');
    expect(out).toContain('#### 🔵 Low (1)');
    expect(out).toContain('#### ➖ Info (1)');
  });

  it('never renders an undefined or NaN count', () => {
    const out = formatFindingsAsSummary([
      { ...validFinding(), severity: 'critical', title: 'c' },
    ]);
    expect(out).not.toContain('undefined');
    expect(out).not.toContain('NaN');
  });
});
