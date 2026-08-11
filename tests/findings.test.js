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
  parseStructuredReview,
  rankAndCapFindings,
  mergeFindings,
  formatFindingsAsSummary,
  hashFinding,
  buildFindingsHashBlock,
  parseFindingsHashBlock,
  filterIncrementalFindings,
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

  // W7-2: LLMs commonly emit incidental trailing/leading whitespace in enum
  // fields (e.g. "critical "). coerceEnum must trim before comparing, otherwise
  // the finding is silently dropped — losing exactly the critical/high findings
  // the bot exists to surface.
  it('W7-2: trims whitespace around severity/confidence/category enums', () => {
    const out = normalizeFinding({
      ...validFinding(),
      severity: ' critical ',
      confidence: ' high ',
      category: ' security ',
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

  // W7-5: finding titles are LLM-emitted and attacker-influenceable. In the
  // walkthrough path they're rendered inside <details> blocks, so a title
  // containing </details> would break the collapsible section and force
  // injected content to render at top level. Strip HTML structural tags.
  it('W7-5: strips HTML structural tags from titles', () => {
    const out = normalizeFinding({
      ...validFinding(),
      title: 'x </details><details><summary>Advisory</summary>',
    });
    expect(out.title).not.toContain('</details>');
    expect(out.title).not.toContain('<details');
    expect(out.title).not.toContain('<summary');
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
    // W2-SEC-6: filename is now rendered as inline code (backticks) instead
    // of bold, to neutralize markdown injection from hostile filenames.
    expect(out).toContain('- `src/index.js`:L42 — Critical bug');
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
    // W2-SEC-6: filename rendered as inline code.
    expect(out).toContain('- `src/index.js` — Possible null dereference');
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

  it('escapes backticks in evidence so the inline-code span is not corrupted (F05)', () => {
    // Evidence is rendered inside backtick code spans. A backtick in the
    // evidence would close the span early and corrupt the markdown.
    // W8-1: backslash escapes do NOT work in CommonMark code spans, so the
    // backtick is replaced with "'" instead.
    const out = formatFindingsAsSummary([
      {
        ...validFinding(),
        evidence: 'foo`bar',
      },
    ]);
    // The literal unescaped "foo`bar" must NOT appear.
    expect(out).not.toContain('foo`bar');
    // The backtick is replaced with a single quote (code-span-safe).
    expect(out).toContain("foo'bar");
  });

  it('W2-SEC-6: neutralizes markdown injection from a filename with ** (bold)', () => {
    // A filename containing markdown metacharacters (e.g. weird**name.js)
    // would render as bold text and corrupt the summary layout. Filenames
    // must be rendered safely (as inline code or with escaped metacharacters).
    const out = formatFindingsAsSummary([
      {
        ...validFinding(),
        file: 'weird**name.js',
        title: 'T',
        description: 'D',
      },
    ]);
    // The raw bold-inducing substring must NOT appear outside an inline-code
    // span. Either the file is wrapped in backticks (preferred) or the
    // asterisks are escaped.
    // Reject the raw "weird**name.js" appearing as a non-code fragment.
    // We do this by ensuring every occurrence of the filename is inside a
    // backtick code span OR the asterisks are backslash-escaped.
    const rawIdx = out.indexOf('weird**name.js');
    if (rawIdx >= 0) {
      // If it appears raw, the surrounding chars must be backticks (inline code).
      const before = out[rawIdx - 1];
      const after = out[rawIdx + 'weird**name.js'.length];
      const isInlineCode = before === '`' && after === '`';
      // As a fallback, allow backslash-escaped asterisks.
      const escapedPresent = out.includes('weird\\*\\*name.js');
      expect(isInlineCode || escapedPresent).toBe(true);
    }
    // Strong assertion: the filename rendered with raw bold markers must not
    // appear as "**weird**name.js**" style bolded text. The original
    // pre-fix bug rendered "- **weird**name.js** — T" which markdown would
    // bold part of. After the fix, the file is wrapped as inline code.
    expect(out).not.toContain('**weird**');
  });

  it('W2-SEC-6: renders the filename as inline code (preferred neutralization)', () => {
    // Preferred fix: wrap the filename in backticks so it renders as inline
    // code and all markdown metacharacters are neutralized.
    const out = formatFindingsAsSummary([
      {
        ...validFinding(),
        file: 'weird**name.js',
      },
    ]);
    // Look for the file as inline code: "`weird**name.js`".
    // The pre-fix code rendered "- **weird**name.js**:L42 — ..."; after the
    // fix, the file should appear inside backticks instead of bold markers.
    expect(out).toContain('`weird**name.js`');
    // The pre-fix bold-wrapped form must be gone.
    expect(out).not.toMatch(/- \*\*weird\*\*name\.js\*\*/);
  });
});

describe('parseStructuredReview', () => {
  const changedFiles = [{ filename: 'src/index.js' }];

  const validPayload = JSON.stringify({
    summary: 'Two findings: a null deref and a missing guard.',
    findings: [
      {
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
      },
    ],
  });

  it('returns {summary, findings} from a JSON object payload', () => {
    const { summary, findings } = parseStructuredReview(validPayload, {
      changedFiles,
    });
    expect(summary).toBe(
      'Two findings: a null deref and a missing guard.',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe('src/index.js');
    expect(findings[0].title).toBe('Possible null dereference');
  });

  it('delegates findings to parseFindings (anti-hallucination filter applies)', () => {
    // A finding whose file is NOT in changedFiles is dropped.
    const payload = JSON.stringify({
      summary: 'hi',
      findings: [
        { ...validFinding(), file: 'src/changed.js' },
        { ...validFinding(), file: 'src/hallucinated.js' },
      ],
    });
    const { findings } = parseStructuredReview(payload, {
      changedFiles: [{ filename: 'src/changed.js' }],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe('src/changed.js');
  });

  it('returns empty summary string when the payload omits .summary', () => {
    const payload = JSON.stringify({
      findings: [{ ...validFinding(), file: 'src/index.js' }],
    });
    const { summary, findings } = parseStructuredReview(payload, {
      changedFiles,
    });
    expect(summary).toBe('');
    expect(findings).toHaveLength(1);
  });

  it('coerces a non-string .summary to ""', () => {
    const payload = JSON.stringify({ summary: 42, findings: [] });
    const { summary } = parseStructuredReview(payload, { changedFiles });
    expect(summary).toBe('');
  });

  it('falls back to treating the payload as a bare findings array', () => {
    // If the model emits just a JSON array (no envelope), summary should be ''
    // and findings should still parse.
    const payload = JSON.stringify([
      { ...validFinding(), file: 'src/index.js' },
    ]);
    const { summary, findings } = parseStructuredReview(payload, {
      changedFiles,
    });
    expect(summary).toBe('');
    expect(findings).toHaveLength(1);
  });

  it('returns {summary: "", findings: []} on unparseable input (never throws)', () => {
    const { summary, findings } = parseStructuredReview(
      'totally not json at all',
      { changedFiles },
    );
    expect(summary).toBe('');
    expect(findings).toEqual([]);
  });

  it('returns {summary: "", findings: []} on empty string', () => {
    const { summary, findings } = parseStructuredReview('', { changedFiles });
    expect(summary).toBe('');
    expect(findings).toEqual([]);
  });

  it('tolerates a fenced ```json code block wrapping the object', () => {
    const fenced = '```json\n' + validPayload + '\n```';
    const { summary, findings } = parseStructuredReview(fenced, {
      changedFiles,
    });
    expect(summary).toBe(
      'Two findings: a null deref and a missing guard.',
    );
    expect(findings).toHaveLength(1);
  });

  it('tolerates a fenced ``` code block wrapping the object', () => {
    const fenced = '```\n' + validPayload + '\n```';
    const { findings } = parseStructuredReview(fenced, { changedFiles });
    expect(findings).toHaveLength(1);
  });

  it('tolerates prose around the JSON object (greedy brace scan)', () => {
    const wrapped =
      'Here is my review:\n' + validPayload + '\nHope this helps!';
    const { summary, findings } = parseStructuredReview(wrapped, {
      changedFiles,
    });
    expect(summary).toBe(
      'Two findings: a null deref and a missing guard.',
    );
    expect(findings).toHaveLength(1);
  });

  it('dedupes findings the same way parseFindings does', () => {
    const dup = { ...validFinding(), file: 'src/index.js' };
    const payload = JSON.stringify({
      summary: '',
      findings: [dup, { ...dup }],
    });
    const { findings } = parseStructuredReview(payload, { changedFiles });
    expect(findings).toHaveLength(1);
  });

  it('normalizes findings (enum casing, title truncation, rule default)', () => {
    const payload = JSON.stringify({
      summary: '',
      findings: [
        {
          file: 'src/index.js',
          line: 1,
          severity: 'HIGH',
          confidence: 'Medium',
          category: 'Bug',
          title: 'x'.repeat(200),
          description: 'd',
          evidence: '',
        },
      ],
    });
    const [f] = parseStructuredReview(payload, { changedFiles }).findings;
    expect(f.severity).toBe('high');
    expect(f.confidence).toBe('medium');
    expect(f.category).toBe('bug');
    expect(f.rule).toBe('llm');
    expect(typeof f.title).toBe('string');
    expect(f.title.length).toBeLessThanOrEqual(120);
  });

  it('passes changedFiles through to the underlying parseFindings', () => {
    // No changedFiles provided → anti-hallucination filter is empty → all
    // findings dropped (the filter requires every finding's file to be listed).
    const payload = JSON.stringify({
      summary: 's',
      findings: [{ ...validFinding(), file: 'src/index.js' }],
    });
    const { findings } = parseStructuredReview(payload);
    expect(findings).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Phase 6.3 — incremental review (findings dedup across runs)
 * ------------------------------------------------------------------ */

describe('hashFinding', () => {
  it('is stable: the same finding content yields the same hash', () => {
    const a = hashFinding(validFinding());
    const b = hashFinding(validFinding());
    expect(a).toBe(b);
  });

  it('produces a 64-char SHA-256 hex string', () => {
    const h = hashFinding(validFinding());
    expect(typeof h).toBe('string');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the file changes', () => {
    const a = hashFinding(validFinding());
    const b = hashFinding({ ...validFinding(), file: 'src/other.js' });
    expect(a).not.toBe(b);
  });

  it('changes when the line changes', () => {
    const a = hashFinding(validFinding());
    const b = hashFinding({ ...validFinding(), line: 43 });
    expect(a).not.toBe(b);
  });

  it('changes when the severity changes', () => {
    const a = hashFinding(validFinding());
    const b = hashFinding({ ...validFinding(), severity: 'critical' });
    expect(a).not.toBe(b);
  });

  it('changes when the title changes', () => {
    const a = hashFinding(validFinding());
    const b = hashFinding({ ...validFinding(), title: 'A different issue' });
    expect(a).not.toBe(b);
  });

  it('changes when the description changes', () => {
    const a = hashFinding(validFinding());
    const b = hashFinding({ ...validFinding(), description: 'A different body.' });
    expect(a).not.toBe(b);
  });

  it('treats null line deterministically (collapses to "null")', () => {
    // Two file-level findings at the same file with the same content hash equal.
    const a = hashFinding({ ...validFinding(), line: null });
    const b = hashFinding({ ...validFinding(), line: null });
    expect(a).toBe(b);
  });

  it('ignores fields that are NOT part of the hash key (evidence, suggestion, rule, confidence, category)', () => {
    const base = validFinding();
    const a = hashFinding(base);
    const b = hashFinding({
      ...base,
      evidence: 'different evidence',
      suggestion: 'different suggestion',
      rule: 'eslint:x',
      confidence: 'high',
      category: 'security',
    });
    // The hash is over file:line:severity:title:description only.
    expect(a).toBe(b);
  });

  it('treats a finding with line:null and a finding with line omitted identically', () => {
    const withNull = { ...validFinding(), line: null };
    const { line: _omit, ...withoutLine } = validFinding();
    void _omit;
    expect(hashFinding(withNull)).toBe(hashFinding({ ...withoutLine, line: null }));
  });

  it('includes evidence in the hash for secret/security rules (regex:/gitleaks:/secret:) [SCN-3]', () => {
    // Two findings at the same file:line:severity:title:description but with
    // DIFFERENT evidence, where rule starts with `regex:`. A rotated secret
    // has different evidence and must hash differently so it is re-surfaced.
    const base = { ...validFinding(), rule: 'regex:github-pat' };
    const a = hashFinding(base);
    const b = hashFinding({ ...base, evidence: 'ghp_…different' });
    expect(a).not.toBe(b);
  });

  it('keeps the same hash for non-security findings when only evidence changes [SCN-3]', () => {
    // For non-security findings (rule not matching regex:/gitleaks:/secret:),
    // evidence remains excluded for stability.
    const base = { ...validFinding(), rule: 'llm' };
    const a = hashFinding(base);
    const b = hashFinding({ ...base, evidence: 'different evidence' });
    expect(a).toBe(b);
  });

  it('W2-5: includes evidence in the hash for astgrep: security rules', () => {
    // astgrep: rules are deterministic scanner findings (eval, sql-concat,
    // etc.). Like regex:/gitleaks:/secret: rules, when the evidence changes
    // the finding must hash differently so a new occurrence is re-surfaced
    // rather than suppressed as "unchanged".
    const base = { ...validFinding(), rule: 'astgrep:eval' };
    const a = hashFinding(base);
    const b = hashFinding({ ...base, evidence: 'eval("different")' });
    expect(a).not.toBe(b);
  });

  it('W2-5: includes evidence in the hash for astgrep:sql-concat', () => {
    const base = { ...validFinding(), rule: 'astgrep:sql-concat' };
    const a = hashFinding(base);
    const b = hashFinding({ ...base, evidence: 'query("SELECT " + id)' });
    expect(a).not.toBe(b);
  });

  it('W2-5: keeps llm findings evidence-excluded for stability (regression)', () => {
    // LLM findings (no rule or rule: 'llm') keep the old behavior: evidence
    // is excluded so a re-review that only changed the suggestion/evidence
    // text does not re-surface the finding.
    const base = { ...validFinding(), rule: 'llm' };
    const a = hashFinding(base);
    const b = hashFinding({ ...base, evidence: 'different evidence' });
    expect(a).toBe(b);
  });
});

describe('buildFindingsHashBlock', () => {
  it('renders the canonical hidden-comment block with comma-joined hashes', () => {
    const f1 = validFinding();
    const f2 = { ...validFinding(), line: 99, title: 'Other' };
    const block = buildFindingsHashBlock([f1, f2]);
    const h1 = hashFinding(f1);
    const h2 = hashFinding(f2);
    expect(block).toBe(`<!-- zai-hashes:${h1},${h2} -->`);
  });

  it('emits an empty hashes block for an empty findings list', () => {
    expect(buildFindingsHashBlock([])).toBe('<!-- zai-hashes: -->');
  });

  it('emits a single-hash block for one finding', () => {
    const f = validFinding();
    expect(buildFindingsHashBlock([f])).toBe(
      `<!-- zai-hashes:${hashFinding(f)} -->`,
    );
  });

  it('dedups repeated hashes (same finding twice → one entry)', () => {
    const f = validFinding();
    const block = buildFindingsHashBlock([f, { ...f }]);
    expect(block).toBe(`<!-- zai-hashes:${hashFinding(f)} -->`);
  });
});

describe('parseFindingsHashBlock', () => {
  it('returns a Set of the hashes embedded in the block', () => {
    const f1 = validFinding();
    const f2 = { ...validFinding(), line: 7, title: 'X' };
    const body = `## Review\n\nprose\n\n${buildFindingsHashBlock([f1, f2])}`;
    const set = parseFindingsHashBlock(body);
    expect(set).toBeInstanceOf(Set);
    expect(set.size).toBe(2);
    expect(set.has(hashFinding(f1))).toBe(true);
    expect(set.has(hashFinding(f2))).toBe(true);
  });

  it('round-trips through build → parse losslessly', () => {
    const findings = [
      validFinding(),
      { ...validFinding(), line: 10, title: 'A' },
      { ...validFinding(), line: 20, title: 'B', severity: 'critical' },
    ];
    const block = buildFindingsHashBlock(findings);
    const parsed = parseFindingsHashBlock(block);
    for (const f of findings) {
      expect(parsed.has(hashFinding(f))).toBe(true);
    }
    expect(parsed.size).toBe(findings.length);
  });

  it('returns an empty Set when the body has no hash block', () => {
    const set = parseFindingsHashBlock('## Review\n\nNo hashes here.');
    expect(set.size).toBe(0);
  });

  it('returns an empty Set when the block is empty (<!-- zai-hashes: -->)', () => {
    const set = parseFindingsHashBlock('body\n<!-- zai-hashes: -->');
    expect(set.size).toBe(0);
  });

  it('returns an empty Set for non-string input', () => {
    expect(parseFindingsHashBlock(null).size).toBe(0);
    expect(parseFindingsHashBlock(undefined).size).toBe(0);
  });

  it('coexists with the idempotency MARKER in the same body', () => {
    // The MARKER (<!-- zai-code-review -->) and the hash block are SEPARATE
    // HTML comments in the same review body. Parsing one must not pick up the
    // other.
    const body =
      '## Review\n\nprose\n\n<!-- zai-code-review -->\n<!-- zai-hashes:abc,def -->';
    const hashes = parseFindingsHashBlock(body);
    expect(hashes.size).toBe(2);
    expect(hashes.has('abc')).toBe(true);
    expect(hashes.has('def')).toBe(true);
    expect(hashes.has('<!-- zai-code-review -->')).toBe(false);
  });

  it('picks up the FIRST hash block when multiple are present (oldest wins)', () => {
    const body =
      'x\n<!-- zai-hashes:aaa -->\ny\n<!-- zai-hashes:bbb -->';
    const set = parseFindingsHashBlock(body);
    // First-wins mirrors how the bot reads its own most recent prior review:
    // the canonical block is the last one posted, but if a body somehow has
    // two, we read the first to be conservative. Either way, no throw.
    expect(set.size).toBeGreaterThanOrEqual(1);
    expect(set.has('aaa')).toBe(true);
  });
});

describe('filterIncrementalFindings', () => {
  it('keeps everything when priorHashes is empty (first run)', () => {
    const findings = [validFinding(), { ...validFinding(), line: 9 }];
    const { kept, suppressed } = filterIncrementalFindings(findings, new Set());
    expect(kept).toHaveLength(2);
    expect(suppressed).toBe(0);
  });

  it('drops findings whose hash is in priorHashes', () => {
    const fresh = { ...validFinding(), line: 9, title: 'New' };
    const known = validFinding();
    const prior = new Set([hashFinding(known)]);
    const { kept, suppressed } = filterIncrementalFindings(
      [known, fresh],
      prior,
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ line: 9, title: 'New' });
    expect(suppressed).toBe(1);
  });

  it('keeps findings whose hash is NOT in priorHashes', () => {
    const a = { ...validFinding(), line: 1, title: 'A' };
    const b = { ...validFinding(), line: 2, title: 'B' };
    const prior = new Set([hashFinding(a)]);
    const { kept } = filterIncrementalFindings([a, b], prior);
    expect(kept.map((f) => f.title).sort()).toEqual(['B']);
  });

  it('suppresses ALL findings when all hashes are known', () => {
    const findings = [
      { ...validFinding(), line: 1, title: 'A' },
      { ...validFinding(), line: 2, title: 'B' },
    ];
    const prior = new Set(findings.map(hashFinding));
    const { kept, suppressed } = filterIncrementalFindings(findings, prior);
    expect(kept).toEqual([]);
    expect(suppressed).toBe(2);
  });

  it('preserves the input order of the kept findings', () => {
    const a = { ...validFinding(), line: 1, title: 'A' };
    const b = { ...validFinding(), line: 2, title: 'B' };
    const c = { ...validFinding(), line: 3, title: 'C' };
    const prior = new Set([hashFinding(b)]);
    const { kept } = filterIncrementalFindings([a, b, c], prior);
    expect(kept.map((f) => f.title)).toEqual(['A', 'C']);
  });

  it('does not mutate the input findings array', () => {
    const findings = [validFinding(), { ...validFinding(), line: 9 }];
    const prior = new Set([hashFinding(findings[0])]);
    const snapshot = [...findings];
    filterIncrementalFindings(findings, prior);
    expect(findings).toEqual(snapshot);
  });

  it('treats a finding as "new" only if its hash differs from every prior hash', () => {
    // Same file:line:severity:title:description as a prior → suppressed even if
    // suggestion/evidence/rule differ (those aren't part of the hash).
    const prior = new Set([hashFinding(validFinding())]);
    const tweaked = {
      ...validFinding(),
      evidence: 'brand new evidence',
      suggestion: 'brand new suggestion',
      rule: 'eslint:different',
    };
    const { kept, suppressed } = filterIncrementalFindings([tweaked], prior);
    expect(kept).toEqual([]);
    expect(suppressed).toBe(1);
  });

  it('handles a non-array findings input gracefully', () => {
    const { kept, suppressed } = filterIncrementalFindings(null, new Set());
    expect(kept).toEqual([]);
    expect(suppressed).toBe(0);
  });

  it('handles a non-Set priorHashes (treated as empty)', () => {
    const findings = [validFinding()];
    const { kept, suppressed } = filterIncrementalFindings(findings, null);
    expect(kept).toHaveLength(1);
    expect(suppressed).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Task 5 — additional edge-case coverage for the JSON-extraction
 * internals (exercised indirectly through parseFindings and
 * parseStructuredReview, since extractJsonArray/extractJsonObject are
 * not exported), hashFinding invariants, and rankAndCapFindings /
 * mergeFindings boundary conditions.
 * ------------------------------------------------------------------ */

describe('JSON extraction — array-before-object guard (extractJsonObject)', () => {
  // extractJsonObject guards its greedy brace scan with: if a '[' appears
  // before the first '{', skip the brace scan (otherwise the first array
  // element's {...} would be mistaken for the envelope). This documents that
  // when an array precedes the object, the object is NOT recovered via the
  // brace scan and parseStructuredReview falls back to the empty envelope.
  it('skips the brace scan when a [ appears before the first { (object NOT recovered)', () => {
    const raw =
      "Here is a list: [item1] then " +
      JSON.stringify({ summary: 'review', findings: [] });
    const { summary, findings } = parseStructuredReview(raw);
    // The object is unreachable: trim-strategy fails (does not start with {),
    // fence-strategy finds no fence, and the brace scan is guarded off.
    expect(summary).toBe('');
    expect(findings).toEqual([]);
  });

  it('recovers the object when the [ appears AFTER the { (brace scan active)', () => {
    // Same content but the object comes FIRST, so the brace scan is not
    // guarded off and the envelope is recovered even with trailing prose.
    const obj = { summary: 'review', findings: [] };
    const raw = JSON.stringify(obj) + " trailing [item1] prose";
    const { summary } = parseStructuredReview(raw);
    expect(summary).toBe('review');
  });
});

describe('JSON extraction — fenced code blocks', () => {
  it('extracts the FIRST ```json block when multiple are present', () => {
    // The fence regex is not global — it matches the first occurrence.
    const first = [
      { ...validFinding(), file: 'src/index.js', title: 'first' },
    ];
    const second = [
      { ...validFinding(), file: 'src/index.js', title: 'second' },
    ];
    const raw =
      '```json\n' + JSON.stringify(first) + '\n```\nblah\n```json\n' +
      JSON.stringify(second) + '\n```';
    const out = parseFindings(raw, { changedFiles: ['src/index.js'] });
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('first');
  });

  it('handles a code fence inside a JSON string value (falls back to bracket scan)', () => {
    // The fence regex's lazy match terminates at the FIRST ```, which here is
    // embedded inside a JSON string value. The fenced-block strategy yields
    // truncated, invalid JSON — but extractJsonArray's greedy bracket scan
    // (strategy c) recovers the array as a fallback. This pins that recovery.
    const arr = [
      {
        ...validFinding(),
        description: 'use ```js for highlighting',
      },
    ];
    const raw = '```json\n' + JSON.stringify(arr) + '\n```';
    const out = parseFindings(raw, { changedFiles: ['src/index.js'] });
    expect(out).toHaveLength(1);
    expect(out[0].description).toBe('use ```js for highlighting');
  });

  it('parses a fenced ``` block with no language tag', () => {
    const arr = [{ ...validFinding() }];
    const raw = '```\n' + JSON.stringify(arr) + '\n```';
    const out = parseFindings(raw, { changedFiles: ['src/index.js'] });
    expect(out).toHaveLength(1);
  });
});

describe('JSON extraction — nested structures', () => {
  it('parses a fenced object with nested arrays of objects', () => {
    // Greedy brace scan must match balanced braces around nested content.
    const obj = {
      summary: 'nested ok',
      findings: [],
      items: [{ a: 1 }, { b: 2 }],
    };
    const raw = '```\n' + JSON.stringify(obj) + '\n```';
    const { summary } = parseStructuredReview(raw);
    expect(summary).toBe('nested ok');
  });

  it('parses an array whose elements contain nested objects with arrays', () => {
    const arr = [{ items: [{ a: 1 }, { b: 2 }] }];
    const raw = JSON.stringify(arr);
    // No changedFiles match (the finding would fail the file filter), but the
    // array itself must still parse without throwing.
    expect(() => parseFindings(raw, { changedFiles: [] })).not.toThrow();
    expect(parseFindings(raw, { changedFiles: [] })).toEqual([]);
  });
});

describe('hashFinding — invariants and volatility', () => {
  it('is invariant under changes to evidence, suggestion, confidence, category, rule', () => {
    // Documents the intentional design: the hash deliberately excludes the
    // volatile fields so a re-review that only refines the suggestion does
    // NOT re-surface the finding as new.
    const base = validFinding();
    const h1 = hashFinding(base);
    const h2 = hashFinding({
      ...base,
      evidence: 'completely different evidence text',
      suggestion: 'completely different suggestion text',
      confidence: 'low',
      category: 'security',
      rule: 'eslint:some-rule',
    });
    expect(h1).toBe(h2);
  });

  it('is sensitive to title changes alone', () => {
    const base = validFinding();
    const h1 = hashFinding(base);
    const h2 = hashFinding({ ...base, title: 'A different issue entirely' });
    expect(h1).not.toBe(h2);
  });

  it('treats line:null and line:undefined identically (both collapse to "null")', () => {
    const base = validFinding();
    const hNull = hashFinding({ ...base, line: null });
    const hUndef = hashFinding({ ...base, line: undefined });
    expect(hNull).toBe(hUndef);
  });

  it('does not throw when line is null', () => {
    const base = validFinding();
    expect(() => hashFinding({ ...base, line: null })).not.toThrow();
    // And still yields a well-formed 64-char hex digest.
    expect(hashFinding({ ...base, line: null })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('rankAndCapFindings — boundary options', () => {
  it('returns an empty array when maxFindings is 0', () => {
    const findings = [
      { ...validFinding(), severity: 'critical' },
      { ...validFinding(), severity: 'high' },
    ];
    expect(rankAndCapFindings(findings, { maxFindings: 0 })).toEqual([]);
  });

  it('falls back to the default cap (8) for a negative maxFindings', () => {
    // The guard is `maxFindings >= 0`; -1 fails it and falls back to 8, so
    // the result is NOT empty — it is capped at the default of 8.
    const findings = Array.from({ length: 12 }, () => ({ ...validFinding() }));
    const out = rankAndCapFindings(findings, { maxFindings: -1 });
    expect(out).toHaveLength(8);
  });

  it('minSeverity medium keeps critical/high/medium and drops low/info', () => {
    const findings = [
      { ...validFinding(), severity: 'critical', file: 'a', line: 1 },
      { ...validFinding(), severity: 'high', file: 'a', line: 2 },
      { ...validFinding(), severity: 'medium', file: 'a', line: 3 },
      { ...validFinding(), severity: 'low', file: 'a', line: 4 },
      { ...validFinding(), severity: 'info', file: 'a', line: 5 },
    ];
    const out = rankAndCapFindings(findings, { minSeverity: 'medium' });
    expect(out.map((f) => f.severity)).toEqual([
      'critical',
      'high',
      'medium',
    ]);
  });

  it('returns an empty array for an empty findings array regardless of options', () => {
    expect(rankAndCapFindings([], { maxFindings: 100, minSeverity: 'info' })).toEqual([]);
  });

  it('falls back to the default cap when maxFindings is omitted', () => {
    const findings = Array.from({ length: 12 }, () => ({ ...validFinding() }));
    expect(rankAndCapFindings(findings)).toHaveLength(8);
  });

  it('does not mutate the input array', () => {
    const findings = [
      { ...validFinding(), severity: 'low', file: 'b', line: 1 },
      { ...validFinding(), severity: 'critical', file: 'a', line: 1 },
    ];
    const snapshot = [...findings];
    rankAndCapFindings(findings);
    expect(findings).toEqual(snapshot);
  });
});

describe('mergeFindings — deterministic-supersedes-LLM edge cases', () => {
  // NOTE: signature is mergeFindings(llmFindings, deterministicFindings).
  it('deterministic supersedes LLM when title matches case-insensitively at same file:line', () => {
    const llm = [
      { ...validFinding(), file: 'a.js', line: 5, title: 'SQL Injection', rule: 'llm' },
    ];
    const det = [
      { ...validFinding(), file: 'a.js', line: 5, title: 'sql injection', rule: 'semgrep' },
    ];
    const out = mergeFindings(llm, det);
    expect(out).toHaveLength(1);
    expect(out[0].rule).toBe('semgrep');
  });

  it('keeps both findings when same file:line but titles differ', () => {
    const llm = [
      { ...validFinding(), file: 'a.js', line: 5, title: 'SQL Injection', rule: 'llm' },
    ];
    const det = [
      { ...validFinding(), file: 'a.js', line: 5, title: 'XSS via innerHTML', rule: 'semgrep' },
    ];
    const out = mergeFindings(llm, det);
    expect(out).toHaveLength(2);
    expect(out.map((f) => f.rule).sort()).toEqual(['llm', 'semgrep']);
  });

  it('every deterministic finding always survives regardless of LLM overlap', () => {
    // Two distinct deterministic findings at the same location both survive.
    const llm = [{ ...validFinding(), file: 'a.js', line: 5, title: 'A', rule: 'llm' }];
    const det = [
      { ...validFinding(), file: 'a.js', line: 5, title: 'A', rule: 'det-a' },
      { ...validFinding(), file: 'a.js', line: 5, title: 'B', rule: 'det-b' },
    ];
    const out = mergeFindings(llm, det);
    const detOut = out.filter((f) => typeof f.rule === 'string' && f.rule.startsWith('det-'));
    expect(detOut).toHaveLength(2);
    // The LLM 'A' is suppressed (covered by det 'A'); only the two dets survive.
    expect(out).toHaveLength(2);
  });

  it('returns just the deterministic findings when LLM array is empty', () => {
    const det = [{ ...validFinding(), file: 'a.js', line: 1, title: 'D', rule: 'semgrep' }];
    const out = mergeFindings([], det);
    expect(out).toEqual(det);
  });

  it('returns just the LLM findings when deterministic array is empty', () => {
    const llm = [{ ...validFinding(), file: 'a.js', line: 1, title: 'L', rule: 'llm' }];
    const out = mergeFindings(llm, []);
    expect(out).toEqual(llm);
  });

  it('returns an empty array when both inputs are empty', () => {
    expect(mergeFindings([], [])).toEqual([]);
  });
});
