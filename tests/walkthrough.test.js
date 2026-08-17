/**
 * Tests for src/lib/walkthrough.js — Phase 7 cohort classification +
 * dependency-ordered walkthrough rendering.
 *
 * The module is pure (no I/O, no imports of other project modules). These
 * tests pin each contract: classifyFile cohort assignment + edge cases,
 * COHORT_ORDER ordering, cohort grouping, and the formatWalkthroughSummary
 * renderer (structure, emojis, byte-exact marker, empty-findings state,
 * collapsible sections).
 */
import { describe, it, expect } from 'vitest';

import {
  classifyFile,
  COHORT_ORDER,
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

  // CMD-6: classifyFile must follow the canonical dependency order (where
  // 'config' ranks BEFORE 'ui') — historically the matcher table listed
  // 'config' after 'ui', and a reconciliation loop masked it. A path that
  // matches BOTH config and ui cohorts must resolve to config because the
  // canonical order ranks config as more foundational.
  it('CMD-6: classifyFile follows the canonical registry order — config beats ui (pages/settings.json → config)', () => {
    // pages/ matches ui; .json matches config. COHORT_ORDER has config (rank 3)
    // before ui (rank 4), so config wins.
    expect(classifyFile('pages/settings.json')).toBe('config');
    // A .yml file under views/ — both ui (views/) and config (.yml) match.
    expect(classifyFile('views/config.yml')).toBe('config');
    // .tsx under a config dir (.github) — both config (.github) and ui (.tsx).
    expect(classifyFile('.github/workflows/ui.yml')).toBe('config');
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

  // F-COHORTS registry-completeness pin: every COHORT_ORDER entry must be a
  // REAL cohort — reachable through classifyFile and renderable with a full
  // descriptor (non-empty emoji + label). Written against the public export
  // and renderer only, so it holds before AND after the one-registry refactor:
  // no cohort may exist in the export without matchers/emoji/label, and no
  // classifyFile return value may fall outside the export.
  it('every COHORT_ORDER entry is reachable via classifyFile and nothing else is returned', () => {
    // One fixture file per cohort, each hitting that cohort's matchers.
    const fixtures = [
      'db/schema.sql', // database
      'api/users.js', // api
      'src/lib/a.js', // business-logic
      'config.yml', // config
      'components/B.tsx', // ui
      'a.test.js', // tests
      'README.md', // docs
      'Makefile', // other
    ];
    const returned = new Set(fixtures.map((f) => classifyFile(f)));
    expect(returned.size).toBe(COHORT_ORDER.length);
    expect([...returned].sort()).toEqual([...COHORT_ORDER].sort());
  });

  it('renders a fully-populated section header for every COHORT_ORDER entry', () => {
    const findings = [
      { file: 'db/schema.sql', severity: 'info', title: '1' },
      { file: 'api/users.js', severity: 'info', title: '2' },
      { file: 'src/lib/a.js', severity: 'info', title: '3' },
      { file: 'config.yml', severity: 'info', title: '4' },
      { file: 'components/B.tsx', severity: 'info', title: '5' },
      { file: 'a.test.js', severity: 'info', title: '6' },
      { file: 'README.md', severity: 'info', title: '7' },
      { file: 'Makefile', severity: 'info', title: '8' },
    ];
    const files = findings.map((f) => ({ filename: f.file }));
    const out = formatWalkthroughSummary(findings, files, {});
    const summaryLines = out.split('\n').filter((l) => l.startsWith('<summary>'));
    // One section per cohort — the export can never name a cohort the
    // renderer cannot render.
    expect(summaryLines).toHaveLength(COHORT_ORDER.length);
    // Every header carries a non-empty emoji and a non-empty label.
    for (const line of summaryLines) {
      expect(line).toMatch(/^<summary>\S+ \S[^\n]* \(\d+\)<\/summary>$/);
    }
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

  // W6-4: filenames must be rendered as inline code, not raw markdown (sibling
  // of W2-SEC-6 in findings.js). A malicious filename with markdown
  // metacharacters would inject formatting/links.
  it('W6-4: renders filenames as inline code, not raw markdown', () => {
    const evil = '**[phish](https://evil.com)**.js';
    const out = formatWalkthroughSummary([baseFinding({ file: evil })], [evil], {
      reviewerName: 'Z.ai Code Review',
    });
    expect(out).toContain('`**[phish](https://evil.com)**.js`');
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
    expect(out).toContain('`db/schema.sql`:L42 — Missing index');
    expect(out).toContain('Add an index.');
    expect(out).toContain('💡 CREATE INDEX ...');
  });

  it('omits the line suffix when line is null', () => {
    const findings = [baseFinding({ line: null })];
    const out = formatWalkthroughSummary(findings, [findings[0].file], {});
    expect(out).toContain('`db/schema.sql` — Missing index');
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

  // W16-B1-4: metadata.summary is model-controlled prose and was rendered RAW
  // with newlines/HTML — an injected 'ok\n#### INJECTED <script>' became a
  // real heading (and raw HTML) inside the bot's trusted comment. The
  // walkthrough renderer now applies the same treatment as finding text
  // fields (newline collapse + angle-bracket escaping) — mirroring
  // formatFindingsAsSummary.
  it('W16-B1-4: flattens and escapes an injected heading/HTML summary', () => {
    const out = formatWalkthroughSummary([], [], {
      metadata: { summary: 'ok\n#### INJECTED [a](https://x.example) <script>' },
    });
    expect(out).not.toMatch(/^#### INJECTED/m);
    expect(out).not.toMatch(/^#{1,6} INJECTED/m);
    // Flattened onto one line; link syntax stays literal; HTML is escaped.
    expect(out).toContain('ok #### INJECTED [a](https://x.example)');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
    expect(out.endsWith(MARKER)).toBe(true);
  });

  it('W16-B1-4: leaves a plain single-line summary unchanged', () => {
    const out = formatWalkthroughSummary([baseFinding()], [baseFinding().file], {
      metadata: { summary: 'This PR adds a users table.' },
    });
    expect(out).toContain('This PR adds a users table.');
    expect(out.endsWith(MARKER)).toBe(true);
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
