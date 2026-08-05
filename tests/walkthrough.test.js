/**
 * Tests for src/lib/walkthrough.js — Phase 7 cohort classification +
 * dependency-ordered walkthrough rendering.
 *
 * The module is pure (no I/O, no imports of other project modules). These
 * tests pin each contract: classifyFile cohort assignment + edge cases,
 * COHORT_ORDER ordering, buildCohorts (ordering + empty input), cohort grouping,
 * and the formatWalkthroughSummary renderer (structure, emojis, byte-exact
 * marker, empty-findings state, collapsible sections).
 */
import { describe, it, expect } from 'vitest';

import {
  classifyFile,
  COHORT_ORDER,
  buildCohorts,
  groupFindingsByCohort,
  formatWalkthroughSummary,
} from '../src/lib/walkthrough.js';
import { MARKER } from '../src/lib/comments.js';

/* ------------------------------------------------------------------ *
 * classifyFile
 * ------------------------------------------------------------------ */

describe('classifyFile', () => {
  it('classifies database paths', () => {
    expect(classifyFile('db/schema.sql')).toBe('database');
    expect(classifyFile('migrations/0001_init.sql')).toBe('database');
    expect(classifyFile('prisma/schema.prisma')).toBe('database');
    expect(classifyFile('schema/users.sql')).toBe('database');
    expect(classifyFile('db/migrations/001.sql')).toBe('database');
  });

  it('classifies *.sql anywhere as database', () => {
    expect(classifyFile('foo/bar/tables.sql')).toBe('database');
    expect(classifyFile('root.sql')).toBe('database');
  });

  it('classifies *.prisma anywhere as database', () => {
    expect(classifyFile('anything.prisma')).toBe('database');
  });

  it('classifies api paths', () => {
    expect(classifyFile('api/users.js')).toBe('api');
    expect(classifyFile('server/index.js')).toBe('api');
    expect(classifyFile('routes/users.js')).toBe('api');
    expect(classifyFile('controllers/userController.js')).toBe('api');
    expect(classifyFile('endpoints/posts.js')).toBe('api');
    expect(classifyFile('handlers/auth.js')).toBe('api');
  });

  it('classifies business-logic paths', () => {
    expect(classifyFile('src/lib/findings.js')).toBe('business-logic');
    expect(classifyFile('src/services/auth.js')).toBe('business-logic');
    expect(classifyFile('src/models/user.js')).toBe('business-logic');
    expect(classifyFile('domain/user.js')).toBe('business-logic');
    expect(classifyFile('core/engine.js')).toBe('business-logic');
    expect(classifyFile('business/rules.js')).toBe('business-logic');
  });

  it('classifies ui paths', () => {
    expect(classifyFile('components/Button.tsx')).toBe('ui');
    expect(classifyFile('pages/index.jsx')).toBe('ui');
    expect(classifyFile('views/Home.vue')).toBe('ui');
    expect(classifyFile('ui/Card.svelte')).toBe('ui');
    expect(classifyFile('src/app/layout.tsx')).toBe('ui');
    expect(classifyFile('app/Button.tsx')).toBe('ui');
  });

  it('classifies *.tsx / *.jsx / *.vue / *.svelte anywhere as ui', () => {
    expect(classifyFile('foo/Bar.tsx')).toBe('ui');
    expect(classifyFile('random.jsx')).toBe('ui');
    expect(classifyFile('deep/nested/X.vue')).toBe('ui');
    expect(classifyFile('a/b/c/Y.svelte')).toBe('ui');
  });

  it('classifies tests paths', () => {
    expect(classifyFile('foo.test.js')).toBe('tests');
    expect(classifyFile('foo.spec.ts')).toBe('tests');
    expect(classifyFile('__tests__/foo.js')).toBe('tests');
    expect(classifyFile('tests/foo.js')).toBe('tests');
    expect(classifyFile('test/foo.js')).toBe('tests');
  });

  it('classifies config paths', () => {
    expect(classifyFile('config.yml')).toBe('config');
    expect(classifyFile('foo/bar.yaml')).toBe('config');
    expect(classifyFile('tsconfig.json')).toBe('config');
    expect(classifyFile('.github/workflows/ci.yml')).toBe('config');
    expect(classifyFile('Dockerfile')).toBe('config');
    expect(classifyFile('docker-compose.yml')).toBe('config');
    expect(classifyFile('pyproject.toml')).toBe('config');
    expect(classifyFile('.env')).toBe('config');
    expect(classifyFile('.env.local')).toBe('config');
  });

  it('classifies docs paths', () => {
    expect(classifyFile('README.md')).toBe('docs');
    expect(classifyFile('docs/guide.md')).toBe('docs');
    expect(classifyFile('CHANGELOG.md')).toBe('docs');
    expect(classifyFile('NOTES.rst')).toBe('docs');
  });

  it('classifies *.md anywhere as docs', () => {
    expect(classifyFile('foo/bar/notes.md')).toBe('docs');
  });

  it('returns "other" for unclassifiable paths', () => {
    expect(classifyFile('index.js')).toBe('other');
    expect(classifyFile('utils.ts')).toBe('other');
    expect(classifyFile('main.py')).toBe('other');
    expect(classifyFile('Makefile')).toBe('other');
  });

  it('handles edge cases defensively', () => {
    expect(classifyFile('')).toBe('other');
    expect(classifyFile('README')).toBe('docs'); // bare README keyword
  });

  it('respects first-match-wins: src/lib path beats *.test.* (business-logic before tests)', () => {
    // The rules are checked in the documented order (database, api,
    // business-logic, ui, tests, ...). A test file inside src/lib/ matches
    // business-logic FIRST, so it classifies as business-logic, not tests.
    expect(classifyFile('src/lib/findings.test.js')).toBe('business-logic');
  });

  it('classifies a bare test file (no src/lib prefix) as tests', () => {
    expect(classifyFile('tests/findings.test.js')).toBe('tests');
    expect(classifyFile('foo.spec.js')).toBe('tests');
  });
});

/* ------------------------------------------------------------------ *
 * COHORT_ORDER
 * ------------------------------------------------------------------ */

describe('COHORT_ORDER', () => {
  it('is the canonical dependency-ordered array (foundational first)', () => {
    expect(COHORT_ORDER).toEqual([
      'database',
      'api',
      'business-logic',
      'config',
      'ui',
      'tests',
      'docs',
      'other',
    ]);
  });

  it('has 8 distinct cohorts', () => {
    expect(new Set(COHORT_ORDER).size).toBe(COHORT_ORDER.length);
    expect(COHORT_ORDER.length).toBe(8);
  });
});

/* ------------------------------------------------------------------ *
 * buildCohorts
 * ------------------------------------------------------------------ */

describe('buildCohorts', () => {
  it('returns [] for empty input', () => {
    expect(buildCohorts([])).toEqual([]);
  });

  it('returns [] for non-array input', () => {
    expect(buildCohorts(null)).toEqual([]);
    expect(buildCohorts(undefined)).toEqual([]);
    expect(buildCohorts('nope')).toEqual([]);
  });

  it('groups files by cohort and orders by dependency rank', () => {
    const files = [
      { filename: 'src/lib/findings.js' }, // business-logic
      { filename: 'db/schema.sql' }, // database
      { filename: 'components/Button.tsx' }, // ui
      { filename: 'api/users.js' }, // api
    ];
    const cohorts = buildCohorts(files);
    expect(cohorts.map((c) => c.cohort)).toEqual([
      'database',
      'api',
      'business-logic',
      'ui',
    ]);
  });

  it('only includes cohorts that have files', () => {
    const cohorts = buildCohorts([{ filename: 'README.md' }]);
    expect(cohorts.length).toBe(1);
    expect(cohorts[0].cohort).toBe('docs');
  });

  it('assigns the correct dependency rank index to each cohort', () => {
    const cohorts = buildCohorts([
      { filename: 'README.md' }, // docs → rank 6
      { filename: 'db/schema.sql' }, // database → rank 0
    ]);
    const byName = Object.fromEntries(cohorts.map((c) => [c.cohort, c.rank]));
    expect(byName.database).toBe(0);
    expect(byName.docs).toBe(6);
  });

  it('sorts files within each cohort alphabetically', () => {
    const cohorts = buildCohorts([
      { filename: 'src/lib/zzz.js' },
      { filename: 'src/lib/aaa.js' },
      { filename: 'src/lib/mmm.js' },
    ]);
    expect(cohorts[0].files.map((f) => f.filename)).toEqual([
      'src/lib/aaa.js',
      'src/lib/mmm.js',
      'src/lib/zzz.js',
    ]);
  });

  it('accepts bare string filenames too', () => {
    const cohorts = buildCohorts(['db/a.sql', 'api/b.js']);
    expect(cohorts.map((c) => c.cohort)).toEqual(['database', 'api']);
  });

  it('preserves original file objects in the cohort output', () => {
    const fileObj = { filename: 'db/schema.sql', patch: 'xxx', custom: 1 };
    const cohorts = buildCohorts([fileObj]);
    expect(cohorts[0].files[0]).toBe(fileObj);
  });
});

/* ------------------------------------------------------------------ *
 * groupFindingsByCohort
 * ------------------------------------------------------------------ */

describe('groupFindingsByCohort', () => {
  it('returns a Map keyed by cohort name', () => {
    const findings = [
      { file: 'db/schema.sql', title: 'A' },
      { file: 'api/users.js', title: 'B' },
    ];
    const files = [{ filename: 'db/schema.sql' }, { filename: 'api/users.js' }];
    const map = groupFindingsByCohort(findings, files);
    expect(map).toBeInstanceOf(Map);
    expect(map.get('database')).toHaveLength(1);
    expect(map.get('api')).toHaveLength(1);
  });

  it('assigns findings whose file is not in files to "other"', () => {
    const findings = [
      { file: 'db/schema.sql', title: 'A' },
      { file: 'mystery/ghost.js', title: 'B' },
    ];
    const files = [{ filename: 'db/schema.sql' }];
    const map = groupFindingsByCohort(findings, files);
    expect(map.get('database')).toHaveLength(1);
    expect(map.get('other')).toHaveLength(1);
    expect(map.get('other')[0].file).toBe('mystery/ghost.js');
  });

  it('returns an empty Map for empty findings', () => {
    const map = groupFindingsByCohort([], [{ filename: 'db/schema.sql' }]);
    expect(map.size).toBe(0);
  });

  it('handles non-array inputs defensively', () => {
    const map1 = groupFindingsByCohort(null, []);
    expect(map1.size).toBe(0);
    const map2 = groupFindingsByCohort([{ file: 'a.js' }], null);
    expect(map2.get('other')).toHaveLength(1);
  });

  it('groups multiple findings per cohort', () => {
    const findings = [
      { file: 'src/lib/a.js', title: 'A' },
      { file: 'src/lib/b.js', title: 'B' },
      { file: 'src/lib/c.js', title: 'C' },
    ];
    const files = findings.map((f) => ({ filename: f.file }));
    const map = groupFindingsByCohort(findings, files);
    expect(map.get('business-logic')).toHaveLength(3);
  });
});

/* ------------------------------------------------------------------ *
 * formatWalkthroughSummary
 * ------------------------------------------------------------------ */

describe('formatWalkthroughSummary', () => {
  /** A fully valid finding used as the base. */
  const baseFinding = (overrides = {}) => ({
    file: 'db/schema.sql',
    line: 10,
    severity: 'high',
    confidence: 'medium',
    category: 'bug',
    title: 'Missing index',
    description: 'Add an index on user_id.',
    evidence: '',
    suggestion: 'CREATE INDEX ...',
    rule: 'llm',
    ...overrides,
  });

  it('renders the reviewerName header', () => {
    const out = formatWalkthroughSummary([baseFinding()], [baseFinding().file], {
      reviewerName: 'Z.ai Code Review',
    });
    expect(out).toContain('## Z.ai Code Review');
  });

  it('uses a default reviewerName when none provided', () => {
    const out = formatWalkthroughSummary(
      [baseFinding()],
      [baseFinding().file],
      {},
    );
    expect(out).toContain('## Z.ai Code Review');
  });

  it('renders the Overview line with counts and cohort count', () => {
    const findings = [
      baseFinding({ file: 'db/schema.sql', severity: 'critical' }),
      baseFinding({ file: 'src/lib/a.js', severity: 'high', title: 'X' }),
    ];
    const files = findings.map((f) => ({ filename: f.file }));
    const out = formatWalkthroughSummary(findings, files, {});
    // 2 findings across 2 areas (database + business-logic)
    expect(out).toContain('2 findings across 2 areas');
    expect(out).toContain('🔴 1 critical');
    expect(out).toContain('🟠 1 high');
  });

  it('renders collapsible <details> sections per cohort', () => {
    const findings = [
      baseFinding({ file: 'db/schema.sql', title: 'A' }),
      baseFinding({ file: 'src/lib/a.js', title: 'B', severity: 'medium' }),
    ];
    const files = findings.map((f) => ({ filename: f.file }));
    const out = formatWalkthroughSummary(findings, files, {});
    expect(out).toContain('<details>');
    expect(out).toContain('</details>');
    // database cohort summary line with count
    expect(out).toMatch(/🗄️ Database \(1\)/);
    // business-logic cohort summary line
    expect(out).toMatch(/⚙️ Business Logic \(1\)/);
  });

  it('orders cohort sections by dependency rank (database before business-logic)', () => {
    const findings = [
      baseFinding({ file: 'src/lib/a.js', title: 'B' }),
      baseFinding({ file: 'db/schema.sql', title: 'A' }),
    ];
    const files = findings.map((f) => ({ filename: f.file }));
    const out = formatWalkthroughSummary(findings, files, {});
    const dbIdx = out.indexOf('🗄️');
    const blIdx = out.indexOf('⚙️');
    expect(dbIdx).toBeGreaterThan(-1);
    expect(blIdx).toBeGreaterThan(-1);
    expect(dbIdx).toBeLessThan(blIdx);
  });

  it('renders each finding with file, line, title, description, suggestion', () => {
    const findings = [
      baseFinding({
        file: 'db/schema.sql',
        line: 42,
        title: 'Missing index',
        description: 'Add an index.',
        suggestion: 'CREATE INDEX ...',
      }),
    ];
    const out = formatWalkthroughSummary(findings, [findings[0].file], {});
    expect(out).toContain('**db/schema.sql**:L42 — Missing index');
    expect(out).toContain('Add an index.');
    expect(out).toContain('💡 CREATE INDEX ...');
  });

  it('omits the line suffix when line is null', () => {
    const findings = [baseFinding({ line: null })];
    const out = formatWalkthroughSummary(findings, [findings[0].file], {});
    expect(out).toContain('**db/schema.sql** — Missing index');
    expect(out).not.toContain(':L');
  });

  it('omits the suggestion line when suggestion is null', () => {
    const findings = [baseFinding({ suggestion: null })];
    const out = formatWalkthroughSummary(findings, [findings[0].file], {});
    expect(out).not.toContain('💡');
  });

  it('sorts findings within a cohort by severity', () => {
    const findings = [
      baseFinding({ file: 'db/a.sql', severity: 'low', title: 'Low' }),
      baseFinding({ file: 'db/b.sql', severity: 'critical', title: 'Crit' }),
      baseFinding({ file: 'db/c.sql', severity: 'high', title: 'High' }),
    ];
    const files = findings.map((f) => ({ filename: f.file }));
    const out = formatWalkthroughSummary(findings, files, {});
    const critIdx = out.indexOf('Crit');
    const highIdx = out.indexOf('High');
    const lowIdx = out.indexOf('Low');
    expect(critIdx).toBeLessThan(highIdx);
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it('renders the byte-exact idempotency marker at the end', () => {
    const out = formatWalkthroughSummary(
      [baseFinding()],
      [baseFinding().file],
      {},
    );
    expect(out.endsWith(MARKER)).toBe(true);
  });

  it('renders the "No issues found" message when findings is empty', () => {
    const out = formatWalkthroughSummary([], [], {});
    expect(out).toContain('No issues found. The changes look good. ✅');
    expect(out.endsWith(MARKER)).toBe(true);
  });

  it('falls back to formatFindingsAsSummary-style rendering when no files context', () => {
    // When files is empty/non-array AND there are findings, the renderer must
    // still produce a valid summary (all findings land in 'other').
    const findings = [baseFinding({ file: 'mystery.js' })];
    const out = formatWalkthroughSummary(findings, [], {});
    expect(out).toContain('📦 Other'); // 'other' cohort emoji + label
    expect(out.endsWith(MARKER)).toBe(true);
  });

  it('includes summary prose when provided in metadata.summary', () => {
    const out = formatWalkthroughSummary(
      [baseFinding()],
      [baseFinding().file],
      { metadata: { summary: 'This PR adds a users table.' } },
    );
    expect(out).toContain('This PR adds a users table.');
  });

  it('uses the correct emoji for each cohort', () => {
    const findings = [
      baseFinding({ file: 'db/a.sql', title: '1' }), // 🗄️
      baseFinding({ file: 'api/a.js', title: '2', severity: 'medium' }), // 🔌
      baseFinding({ file: 'src/lib/a.js', title: '3', severity: 'medium' }), // ⚙️
      baseFinding({ file: 'config.yml', title: '4', severity: 'medium' }), // 🔧
      baseFinding({ file: 'components/B.tsx', title: '5', severity: 'medium' }), // 🎨
      baseFinding({ file: 'a.test.js', title: '6', severity: 'medium' }), // 🧪
      baseFinding({ file: 'README.md', title: '7', severity: 'medium' }), // 📚
      baseFinding({ file: 'Makefile', title: '8', severity: 'medium' }), // 📦
    ];
    const files = findings.map((f) => ({ filename: f.file }));
    const out = formatWalkthroughSummary(findings, files, {});
    expect(out).toContain('🗄️');
    expect(out).toContain('🔌');
    expect(out).toContain('⚙️');
    expect(out).toContain('🔧');
    expect(out).toContain('🎨');
    expect(out).toContain('🧪');
    expect(out).toContain('📚');
    expect(out).toContain('📦');
  });
});
