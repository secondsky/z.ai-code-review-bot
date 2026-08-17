/**
 * Phase 7: Walkthrough / cohort ordering.
 *
 * Reorganizes a PR's findings from a flat file list into a dependency-ordered
 * walkthrough — the CodeRabbit "Change Stack" idea. Files are classified into
 * cohorts by path, cohorts are ordered by dependency rank (foundational first:
 * database → api → business-logic → config → ui → tests → docs → other), and
 * findings are rendered under their cohort as collapsible sections so the
 * summary reads like a narrative instead of a flat severity-sorted list.
 *
 * This module is PURE (no I/O). It imports the shared free-text sanitizer and
 * the severity display tables (SEVERITY_RANK / SEVERITY_ORDER / SEVERITY_EMOJI)
 * from findings.js — the severity-domain owner (W16-B1-4) — so the summary
 * prose gets exactly the same treatment and the same severity presentation in
 * both summary renderers; and the idempotency MARKER from comments.js so the
 * renderer's trailing marker is byte-exact by construction.
 *
 * @module src/lib/walkthrough.js
 */

import { MARKER } from './comments.js';
import {
  sanitizeTextField,
  SEVERITY_EMOJI,
  SEVERITY_ORDER,
  SEVERITY_RANK,
} from './findings.js';

// ---------------------------------------------------------------------------
// Cohort registry
// ---------------------------------------------------------------------------

/**
 * Build a regex that matches `segment/` anywhere in the path (as a directory
 * segment). Used for patterns like `db/`, `api/`, `src/lib/`.
 *
 * @param {string} segment  e.g. "db" or "src/lib"
 * @returns {RegExp}
 */
function dirSegment(segment) {
  // Escape regex metacharacters in the segment, then anchor on a leading
  // slash-or-start so "db/" matches "/db/" or "^db/" but not "nodb/".
  const escaped = segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|/)${escaped}/`);
}

/**
 * Build a regex that matches a file extension anywhere. `sql` → `\.sql$`.
 *
 * @param {string} ext  without leading dot
 * @returns {RegExp}
 */
function extRe(ext) {
  const escaped = ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\.${escaped}$`, 'i');
}

/**
 * Build a regex that matches a basename keyword anywhere. `Dockerfile` →
 * matches a path component equal to "Dockerfile" or starting with it (so
 * `docker-compose.yml` matches the `docker-compose` keyword).
 *
 * @param {string} name
 * @returns {RegExp}
 */
function basenameKeyword(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|/)${escaped}`, 'i');
}

/**
 * The single ordered cohort registry — ONE entry per cohort carrying its
 * name, header emoji, display label, and path matchers. The array order IS
 * the canonical dependency order (foundational first: database → api →
 * business-logic → config → ui → tests → docs → other); classifyFile and the
 * renderer both walk it in this order, so "first match wins" and the rendered
 * section order are enforced by construction. CMD-6: 'config' ranks BEFORE
 * 'ui' here, so a path matching both (e.g. pages/settings.json) resolves to
 * config. A filename matches a cohort if ANY of its matchers hits. The
 * trailing 'other' cohort is the fallback — it has no matchers; files that
 * match nothing (or that fail the string guard) land there.
 *
 * @type {Array<{ name: string, emoji: string, label: string, matchers: RegExp[] }>}
 */
const COHORTS = [
  {
    name: 'database',
    emoji: '🗄️',
    label: 'Database',
    matchers: [
      dirSegment('db'),
      dirSegment('migrations'),
      dirSegment('schema'),
      dirSegment('prisma'),
      extRe('sql'),
      extRe('prisma'),
    ],
  },
  {
    name: 'api',
    emoji: '🔌',
    label: 'API',
    matchers: [
      dirSegment('api'),
      dirSegment('server'),
      dirSegment('routes'),
      dirSegment('controllers'),
      dirSegment('endpoints'),
      dirSegment('handlers'),
    ],
  },
  {
    name: 'business-logic',
    emoji: '⚙️',
    label: 'Business Logic',
    matchers: [
      dirSegment('src/lib'),
      dirSegment('src/services'),
      dirSegment('src/models'),
      dirSegment('domain'),
      dirSegment('core'),
      dirSegment('business'),
    ],
  },
  {
    name: 'config',
    emoji: '🔧',
    label: 'Config',
    matchers: [
      extRe('yml'),
      extRe('yaml'),
      extRe('json'),
      extRe('toml'),
      dirSegment('.github'),
      basenameKeyword('Dockerfile'),
      basenameKeyword('docker-compose'),
      basenameKeyword('.env'),
    ],
  },
  {
    name: 'ui',
    emoji: '🎨',
    label: 'UI',
    matchers: [
      dirSegment('components'),
      dirSegment('pages'),
      dirSegment('views'),
      dirSegment('ui'),
      dirSegment('src/app'),
      extRe('tsx'),
      extRe('jsx'),
      extRe('vue'),
      extRe('svelte'),
    ],
  },
  {
    name: 'tests',
    emoji: '🧪',
    label: 'Tests',
    matchers: [
      /\.test\./i,
      /\.spec\./i,
      dirSegment('__tests__'),
      dirSegment('tests'),
      dirSegment('test'),
    ],
  },
  {
    name: 'docs',
    emoji: '📚',
    label: 'Docs',
    matchers: [
      extRe('md'),
      extRe('rst'),
      dirSegment('docs'),
      basenameKeyword('CHANGELOG'),
      basenameKeyword('README'),
    ],
  },
  {
    name: 'other',
    emoji: '📦',
    label: 'Other',
    matchers: [],
  },
];

/**
 * The canonical cohort ordering (dependency rank — foundational first).
 * Lower index = more foundational = rendered earlier. Derived from the
 * registry so the export can never drift from it.
 * @type {string[]}
 */
export const COHORT_ORDER = COHORTS.map((c) => c.name);

// ---------------------------------------------------------------------------
// classifyFile
// ---------------------------------------------------------------------------

/**
 * Classify a changed file into a cohort by its path.
 *
 * The registry is walked in order; the FIRST matching cohort wins (so a test
 * file under `src/lib/` classifies as business-logic, because business-logic
 * ranks before tests — and, per CMD-6, a path matching both config and ui,
 * e.g. pages/settings.json, resolves to config because config ranks first).
 * Files matching no matcher fall back to `'other'`.
 *
 * @param {string} filename
 * @returns {string} cohort name: 'database'|'api'|'business-logic'|'config'|'ui'|'tests'|'docs'|'other'
 */
export function classifyFile(filename) {
  if (typeof filename !== 'string' || filename.length === 0) return 'other';
  for (const cohort of COHORTS) {
    if (cohort.matchers.some((re) => re.test(filename))) return cohort.name;
  }
  return 'other';
}

// ---------------------------------------------------------------------------
// filenameOf
// ---------------------------------------------------------------------------

/**
 * Extract a filename from a file entry that may be a bare string or an object
 * with `.filename` (the GitHub PR shape).
 *
 * @param {unknown} entry
 * @returns {string}
 */
function filenameOf(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    const f = /** @type {{ filename?: unknown }} */ (entry).filename;
    if (typeof f === 'string') return f;
  }
  return '';
}

// ---------------------------------------------------------------------------
// groupFindingsByCohort
// ---------------------------------------------------------------------------

/**
 * Assign findings to their file's cohort.
 *
 * Builds its own `Map<filename, cohort>` by classifying each entry of `files`
 * via {@link classifyFile}, then buckets each finding under its file's cohort.
 * Findings whose `file` is not among `files` fall back to `'other'`.
 *
 * @param {Array<{file?: string}>} findings
 * @param {Array<{filename?: string} | string>} files
 * @returns {Map<string, Array>}
 */
export function groupFindingsByCohort(findings, files) {
  /** @type {Map<string, Array>} */
  const out = new Map();
  if (!Array.isArray(findings)) return out;

  // filename → cohort, built once.
  /** @type {Map<string, string>} */
  const fileCohort = new Map();
  if (Array.isArray(files)) {
    for (const entry of files) {
      const filename = filenameOf(entry);
      if (!filename) continue;
      if (!fileCohort.has(filename)) {
        fileCohort.set(filename, classifyFile(filename));
      }
    }
  }

  const ensure = (cohort) => {
    if (!out.has(cohort)) out.set(cohort, []);
    return out.get(cohort);
  };

  for (const f of findings) {
    const file = f && typeof f.file === 'string' ? f.file : '';
    const cohort = fileCohort.get(file) ?? 'other';
    ensure(cohort).push(f);
  }
  return out;
}

// ---------------------------------------------------------------------------
// formatWalkthroughSummary
// ---------------------------------------------------------------------------

/**
 * Severity rank for a finding; unknown sorts last.
 *
 * @param {string} sev
 * @returns {number}
 */
function severityRank(sev) {
  if (typeof sev === 'string' && Object.prototype.hasOwnProperty.call(SEVERITY_RANK, sev)) {
    return SEVERITY_RANK[sev];
  }
  return Number.MAX_SAFE_INTEGER;
}

/**
 * Render a walkthrough-style summary: cohorts as collapsible sections,
 * findings grouped under their cohort.
 *
 * Structure:
 *   ## <reviewerName>
 *   <summary prose if provided>
 *   ### 📊 Overview
 *   <count> findings across <cohortCount> areas · 🔴 N critical · ...
 *   <for each cohort in dependency order, if it has findings>:
 *   <details><summary><emoji> <Label> (<count>)</summary>
 *   - **<file>**<:L<line>> — <title>
 *     <description>
 *     <💡 suggestion>
 *   </details>
 *   <if no findings>: No issues found. The changes look good. ✅
 *   <!-- zai-code-review -->
 *
 * The trailing marker is byte-exact (required by comments.js idempotency).
 *
 * @param {Array} findings
 * @param {Array} files
 * @param {{ reviewerName?: string, metadata?: Record<string, unknown> }} [options]
 * @returns {string}
 */
export function formatWalkthroughSummary(findings, files, options = {}) {
  const reviewerName =
    typeof options.reviewerName === 'string' && options.reviewerName.length > 0
      ? options.reviewerName
      : 'Z.ai Code Review';
  const metadata =
    options.metadata && typeof options.metadata === 'object' ? options.metadata : {};
  const summaryProse =
    typeof metadata.summary === 'string' ? metadata.summary : '';

  const list = Array.isArray(findings) ? findings : [];

  // Header.
  const lines = [];
  lines.push(`## ${reviewerName}`);
  lines.push('');

  if (summaryProse.length > 0) {
    // W16-B1-4: the summary is model-controlled prose rendered into the
    // bot's trusted comment — sanitize it exactly like finding text fields
    // (newline collapse + angle-bracket escaping) so 'ok\n#### INJECTED'
    // cannot become a real heading and raw `<tag>` HTML stays inert.
    // Mirrors formatFindingsAsSummary.
    lines.push(sanitizeTextField(summaryProse));
    lines.push('');
  }

  // Phase 8.1: optional pre-rendered "Suggested reviewers" line (CODEOWNERS).
  const suggestedReviewersLine =
    typeof metadata.suggestedReviewersLine === 'string' ? metadata.suggestedReviewersLine : '';
  if (suggestedReviewersLine.length > 0) {
    lines.push(suggestedReviewersLine);
    lines.push('');
  }

  // Count per severity.
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of list) {
    const sev = typeof f.severity === 'string' ? f.severity : '';
    if (Object.prototype.hasOwnProperty.call(counts, sev)) counts[sev] += 1;
  }
  const total = list.length;

  // Cohort buckets (ordered by dependency rank). Registry order IS the
  // canonical order (COHORT_ORDER derives from it), so filtering the registry
  // yields the ordered cohort list carrying full descriptors. Map keys come
  // only from classifyFile or the 'other' fallback — both registry names — so
  // the descriptor reads below cannot miss.
  const grouped = groupFindingsByCohort(list, files);
  const orderedCohorts = COHORTS.filter(
    (c) => grouped.has(c.name) && grouped.get(c.name).length > 0,
  );
  const cohortCount = orderedCohorts.length;

  // Overview line.
  lines.push('### 📊 Overview');
  lines.push('');
  const sevParts = SEVERITY_ORDER.map(
    (sev) => `${SEVERITY_EMOJI[sev]} ${counts[sev]} ${sev}`,
  );
  lines.push(
    `${total} findings across ${cohortCount} areas · ${sevParts.join(' · ')}`,
  );
  lines.push('');

  if (total === 0) {
    lines.push('No issues found. The changes look good. ✅');
    lines.push('');
  } else {
    for (const cohort of orderedCohorts) {
      const cohortFindings = grouped.get(cohort.name).slice().sort((a, b) => {
        const sa = severityRank(typeof a.severity === 'string' ? a.severity : '');
        const sb = severityRank(typeof b.severity === 'string' ? b.severity : '');
        if (sa !== sb) return sa - sb;
        return 0;
      });
      lines.push('<details>');
      lines.push(
        `<summary>${cohort.emoji} ${cohort.label} (${cohortFindings.length})</summary>`,
      );
      lines.push('');
      for (const f of cohortFindings) {
        const file = typeof f.file === 'string' ? f.file : '';
        const line = f.line;
        const title = typeof f.title === 'string' ? f.title : '';
        const description = typeof f.description === 'string' ? f.description : '';
        const suggestion =
          typeof f.suggestion === 'string' && f.suggestion.length > 0
            ? f.suggestion
            : null;

        const locSuffix = typeof line === 'number' && line > 0 ? `:L${line}` : '';
        // W6-4: filenames are attacker-controlled — render as inline code.
        // W8-1: replace backticks (escapes don't work in code spans).
        const safeFile = String(file).replace(/`/g, "'");
        lines.push(`- \`${safeFile}\`${locSuffix} — ${title}`);
        if (description.length > 0) {
          lines.push(`  ${description}`);
        }
        if (suggestion !== null) {
          lines.push(`  💡 ${suggestion}`);
        }
      }
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
  }

  lines.push(MARKER);
  return lines.join('\n');
}
