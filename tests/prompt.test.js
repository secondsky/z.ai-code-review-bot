/**
 * Tests for src/lib/prompt.js — centralized prompt strings (single source of truth).
 *
 * These tests assert the EXACT default prompt string from the brief and the
 * real formatting behavior of the auto-review prompt builder.
 */
import {
  DEFAULT_SYSTEM_PROMPT,
  resolveSystemPrompt,
  buildAutoReviewPrompt,
} from '../src/lib/prompt.js';

const EXACT_DEFAULT =
  'You are an expert code reviewer. Review the provided pull-request changes and give clear, actionable feedback. Focus on concrete bugs, security issues, risky logic, and architecture mismatches. Skip trivial style comments.';

const HEADER =
  'Please review the following pull request changes and provide concise, constructive feedback. Focus on bugs, logic errors, security issues, and meaningful improvements. Skip trivial style comments.';

describe('DEFAULT_SYSTEM_PROMPT', () => {
  test('is the exact string from the brief', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toBe(EXACT_DEFAULT);
  });
});

describe('resolveSystemPrompt', () => {
  test('returns the config value when non-empty', () => {
    expect(resolveSystemPrompt({ systemPrompt: 'custom instructions' })).toBe('custom instructions');
  });

  test('falls back to DEFAULT when systemPrompt is undefined', () => {
    expect(resolveSystemPrompt({})).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(resolveSystemPrompt({})).toBe(EXACT_DEFAULT);
  });

  test('falls back when systemPrompt is empty string', () => {
    expect(resolveSystemPrompt({ systemPrompt: '' })).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test('falls back when systemPrompt is whitespace-only', () => {
    expect(resolveSystemPrompt({ systemPrompt: '   \n\t ' })).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test('tolerates missing config object entirely', () => {
    expect(resolveSystemPrompt(undefined)).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test('does not trim the returned non-empty value', () => {
    expect(resolveSystemPrompt({ systemPrompt: '  keep me  ' })).toBe('  keep me  ');
  });
});

describe('buildAutoReviewPrompt', () => {
  test('formats two patchable files with header + both entries', () => {
    const files = [
      { filename: 'a.js', status: 'modified', patch: '@@ a @@' },
      { filename: 'src/b.ts', status: 'added', patch: '@@ b @@' },
    ];

    const out = buildAutoReviewPrompt(files);

    const expectedEntry1 = '### a.js (modified)\n```diff\n@@ a @@\n```';
    const expectedEntry2 = '### src/b.ts (added)\n```diff\n@@ b @@\n```';
    expect(out).toBe(`${HEADER}\n\n${expectedEntry1}\n\n${expectedEntry2}`);
  });

  test('empty files → header only', () => {
    expect(buildAutoReviewPrompt([])).toBe(HEADER);
  });

  test('undefined files → header only (defensive)', () => {
    expect(buildAutoReviewPrompt(undefined)).toBe(HEADER);
  });

  test('file with no patch is skipped (defensive — caller filters)', () => {
    const files = [
      { filename: 'a.js', status: 'modified', patch: '@@ a @@' },
      { filename: 'b.png', status: 'added', patch: undefined },
      { filename: 'c.js', status: 'modified', patch: '' },
    ];
    const out = buildAutoReviewPrompt(files);
    expect(out).toBe(`${HEADER}\n\n### a.js (modified)\n\`\`\`diff\n@@ a @@\n\`\`\``);
  });

  test('maxDiffChars > 0 truncates from the end and appends note', () => {
    const patch = 'x'.repeat(100);
    const files = [
      { filename: 'a.js', status: 'modified', patch },
      { filename: 'b.js', status: 'modified', patch },
    ];
    const entry1 = `### a.js (modified)\n\`\`\`diff\n${patch}\n\`\`\``;
    const entry2 = `### b.js (modified)\n\`\`\`diff\n${patch}\n\`\`\``;
    const note =
      '\n\n> **Note:** The diff exceeded the MAX_DIFF_CHARS limit and was truncated.';

    // Pick a cap that fits entry1 + header but NOT both entries.
    const cap = `${HEADER}\n\n${entry1}`.length + 50;
    expect(cap).toBeLessThan(`${HEADER}\n\n${entry1}\n\n${entry2}`.length);

    const out = buildAutoReviewPrompt(files, { maxDiffChars: cap });
    expect(out.endsWith(note)).toBe(true);
    // First file fits; second dropped.
    expect(out).toContain('### a.js');
    expect(out).not.toContain('### b.js');
    // Body (excluding appended note) within cap.
    expect(out.length - note.length).toBeLessThanOrEqual(cap);
  });

  test('maxDiffChars = 0 → no truncation', () => {
    const files = [
      { filename: 'a.js', status: 'modified', patch: 'x'.repeat(5000) },
      { filename: 'b.js', status: 'modified', patch: 'y'.repeat(5000) },
    ];
    const out = buildAutoReviewPrompt(files, { maxDiffChars: 0 });
    expect(out).toContain('### a.js');
    expect(out).toContain('### b.js');
    expect(out).not.toContain('> **Note:**');
  });

  test('truncation drops trailing files one by one until under limit', () => {
    const mkEntry = (name) => `### ${name} (modified)\n\`\`\`diff\n${'p'.repeat(100)}\n\`\`\``;
    const mkFile = (name) => ({ filename: name, status: 'modified', patch: 'p'.repeat(100) });
    const files = [mkFile('1'), mkFile('2'), mkFile('3')];
    const note =
      '\n\n> **Note:** The diff exceeded the MAX_DIFF_CHARS limit and was truncated.';

    // Header + entry1 + entry2 = roughly fits; entry3 dropped.
    const baseline = `${HEADER}\n\n${mkEntry('1')}\n\n${mkEntry('2')}`;
    const out = buildAutoReviewPrompt(files, { maxDiffChars: baseline.length });
    expect(out).toBe(`${baseline}${note}`);
    expect(out).not.toContain('### 3');
  });
});
