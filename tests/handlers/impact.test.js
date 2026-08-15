/**
 * Tests for src/lib/handlers/impact.js — assess impact/risk.
 *
 * READ-ONLY by default: the assessment is posted as a COMMENT only; NO labels
 * are applied unless ZAI_IMPACT_LABELS is on. These tests assert both the
 * default read-only path and the opt-in label-application feature.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  handleImpactCommand,
  parseSeverity,
  buildDiffContext,
} from '../../src/lib/handlers/impact.js';

function makeOctokit({
  files = [
    { filename: 'src/a.js', status: 'modified', patch: 'patch-a' },
    { filename: 'auth/login.js', status: 'modified', patch: 'patch-b' },
  ],
  labels = [],
} = {}) {
  const calls = {
    createComment: [],
    listFiles: [],
    addLabels: [],
    listLabels: [],
    removeLabel: [],
  };
  const octokit = {
    rest: {
      issues: {
        async createComment(params) {
          calls.createComment.push(params);
          return { data: { id: 1 } };
        },
        async addLabels(params) {
          calls.addLabels.push(params);
          return { data: {} };
        },
        async listLabelsOnIssue(params) {
          calls.listLabels.push(params);
          return { data: labels };
        },
        async removeLabel(params) {
          calls.removeLabel.push(params);
          return { data: {} };
        },
      },
      pulls: {
        async listFiles(params) {
          calls.listFiles.push(params);
          return { data: files };
        },
      },
    },
  };
  octokit.__calls = calls;
  return octokit;
}

function makeContext({ number = 42 } = {}) {
  return {
    repo: { owner: 'owner', repo: 'repo' },
    payload: { issue: { number } },
  };
}

describe('handleImpactCommand — success', () => {
  it('calls callApi once with a risk-assessment prompt and posts the result', async () => {
    const octokit = makeOctokit();
    const callApi = vi.fn(async () => '## Impact: 🟡 medium\n...');

    await handleImpactCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm' },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });

    expect(callApi).toHaveBeenCalledTimes(1);
    const prompt = callApi.mock.calls[0][2];
    // Risk-assessment framing + severity levels.
    expect(prompt.toLowerCase()).toContain('risk');
    expect(prompt).toContain('🟢');
    expect(prompt).toContain('🟡');
    expect(prompt).toContain('🟠');
    expect(prompt).toContain('🔴');
    // Diffs fed in.
    expect(prompt).toContain('src/a.js');
    expect(prompt).toContain('auth/login.js');
    // Result posted.
    expect(octokit.__calls.createComment[0].body).toContain('Impact');
  });
});

describe('handleImpactCommand — read-only invariant', () => {
  it('NEVER calls issues.addLabels when impactLabels is off (default)', async () => {
    const octokit = makeOctokit();
    const callApi = vi.fn(async () => 'impact');
    await handleImpactCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm' },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });
    expect(octokit.__calls.addLabels).toHaveLength(0);
    expect(octokit.__calls.createComment).toHaveLength(1);
  });
});

describe('parseSeverity', () => {
  it('extracts critical from the emoji prefix', () => {
    expect(parseSeverity('🔴 critical\nbig blast radius')).toBe('critical');
  });
  it('extracts high/medium/low from emoji prefixes', () => {
    expect(parseSeverity('🟠 high\n...')).toBe('high');
    expect(parseSeverity('🟡 medium\n...')).toBe('medium');
    expect(parseSeverity('🟢 low\n...')).toBe('low');
  });
  it('falls back to word-form if no emoji', () => {
    expect(parseSeverity('Severity: critical\n...')).toBe('critical');
    expect(parseSeverity('this is HIGH risk')).toBe('high');
  });
  it('returns null when no severity keyword is present', () => {
    expect(parseSeverity('Some generic assessment without a level.')).toBeNull();
  });

  it('M2: does NOT match "highlighted" as "high" (word-boundary)', () => {
    expect(parseSeverity('The diff is highlighted for visibility')).toBeNull();
  });

  it('M2: does NOT match "noncritical" as "critical" (substring)', () => {
    expect(parseSeverity('This is a noncritical change')).toBeNull();
  });

  it('W2-01: does NOT match "non-critical" (hyphenated negation)', () => {
    expect(parseSeverity('This is a non-critical change')).toBeNull();
  });

  it('W2-01: does NOT match "not critical" / "no critical" (negation phrases)', () => {
    expect(parseSeverity('not critical')).toBeNull();
    expect(parseSeverity('no critical issues')).toBeNull();
    expect(parseSeverity('no critical issues, this is straightforward')).toBeNull();
    expect(parseSeverity("isn't high risk")).toBeNull();
  });

  it('M2: does NOT match "lowlight" or "highlight" substrings', () => {
    expect(parseSeverity('lowlight region')).toBeNull();
    expect(parseSeverity('highlighted section')).toBeNull();
  });

  it('M2: matches "medium" as a standalone word in a sentence', () => {
    expect(parseSeverity('Risk is medium overall')).toBe('medium');
  });

  it('M2: matches "critical" on its own first line even with surrounding text', () => {
    expect(parseSeverity('critical\nlarge blast radius')).toBe('critical');
  });

  // CMD-4: severity words must only be matched on the FIRST line (the prompt
  // explicitly asks the model to put the level on its own first line). Matching
  // anywhere in the rationale causes false positives when the rationale happens
  // to mention a severity word.
  it('CMD-4: does NOT match severity words appearing only in later (rationale) lines', () => {
    // First line says low; rationale mentions "high confidence" — must stay low.
    expect(parseSeverity('🟢 low\nrationale mentions high confidence')).toBe('low');
    expect(parseSeverity('🟢 low risk\nThis module provides high-availability guarantees.')).toBe('low');
  });

  // W5-7: the CMD-4 first-line restriction applied to WORD-form severity but
  // NOT to emoji-form — `raw.includes(key)` scanned the entire body. Since the
  // emoji iteration order checks 🔴 (critical) first, a 🔴 appearing anywhere
  // in the rationale overrode the declared severity. Emoji must be restricted
  // to the first line, mirroring word-form matching.
  it('W5-7: does NOT match emoji severity appearing only in the rationale', () => {
    expect(parseSeverity('🟢 low\nThe changes touch the 🔴 auth module.')).toBe('low');
    expect(parseSeverity('🟢 low risk\n🔴 decorative emoji in rationale')).toBe('low');
  });

  it('W5-7: emoji severity on the first line still wins', () => {
    expect(parseSeverity('🔴 critical\nrationale')).toBe('critical');
    expect(parseSeverity('🟡 medium\nrationale mentions 🟢')).toBe('medium');
  });

  // CMD-4: a hyphen is NOT a word boundary for severity words. The previous
  // `\b` treated `-` as a boundary, so "high-availability" matched "high".
  it('CMD-4: does NOT match severity words inside hyphenated compounds', () => {
    expect(parseSeverity('high-availability changes')).toBeNull();
    expect(parseSeverity('low-level optimization')).toBeNull();
  });
});

describe('handleImpactCommand — ZAI_IMPACT_LABELS (opt-in label application)', () => {
  const labelMap = {
    critical: 'zai:critical', high: 'zai:high', medium: 'zai:medium', low: 'zai:low',
  };

  it('applies the mapped zai: label for a critical assessment', async () => {
    const octokit = makeOctokit({ labels: [] });
    const callApi = vi.fn(async () => '🔴 critical\nhuge blast radius');
    await handleImpactCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm', impactLabels: true, impactLabelMap: labelMap },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });
    expect(octokit.__calls.addLabels).toHaveLength(1);
    expect(octokit.__calls.addLabels[0].labels).toEqual(['zai:critical']);
  });

  it('removes a prior zai: label before setting the new one (idempotent)', async () => {
    const octokit = makeOctokit({ labels: [{ name: 'zai:medium' }, { name: 'bug' }] });
    const callApi = vi.fn(async () => '🔴 critical\n...');
    await handleImpactCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm', impactLabels: true, impactLabelMap: labelMap },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });
    // The old zai:medium label was removed...
    expect(octokit.__calls.removeLabel).toHaveLength(1);
    expect(octokit.__calls.removeLabel[0].name).toBe('zai:medium');
    // ...and the new zai:critical label was added.
    expect(octokit.__calls.addLabels[0].labels).toEqual(['zai:critical']);
  });

  it('does NOT touch non-zai (human) labels', async () => {
    const octokit = makeOctokit({ labels: [{ name: 'bug' }, { name: 'priority' }] });
    const callApi = vi.fn(async () => '🟢 low');
    await handleImpactCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm', impactLabels: true, impactLabelMap: labelMap },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });
    // Neither human label was removed.
    expect(octokit.__calls.removeLabel).toHaveLength(0);
    expect(octokit.__calls.addLabels[0].labels).toEqual(['zai:low']);
  });

  it('does NOT apply a label when severity is unmappable (graceful)', async () => {
    const octokit = makeOctokit();
    const callApi = vi.fn(async () => 'No severity keyword here.');
    await handleImpactCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm', impactLabels: true, impactLabelMap: labelMap },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });
    expect(octokit.__calls.addLabels).toHaveLength(0);
    // The assessment was still posted as a comment.
    expect(octokit.__calls.createComment).toHaveLength(1);
  });

  // W18-D3-2: when the model's output is unparseable (parseSeverity → null),
  // a previously applied managed label is now STALE — the new assessment
  // disagrees with (or at least does not confirm) it. The label must be
  // REMOVED (all managed severities) with nothing added. Before the fix,
  // `if (!severity) return false;` returned before the removal loop, so a
  // stale zai:high survived a run whose assessment couldn't be parsed.
  it('W18-D3-2: null severity REMOVES existing managed labels and adds nothing', async () => {
    const octokit = makeOctokit({
      labels: [{ name: 'zai:high' }, { name: 'bug' }],
    });
    const callApi = vi.fn(async () => 'I cannot assess the impact of these changes.');
    await handleImpactCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm', impactLabels: true, impactLabelMap: labelMap },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });
    // The stale managed label was removed...
    expect(octokit.__calls.removeLabel).toHaveLength(1);
    expect(octokit.__calls.removeLabel[0].name).toBe('zai:high');
    // ...nothing was added, and human labels ("bug") were untouched.
    expect(octokit.__calls.addLabels).toHaveLength(0);
    // The assessment was still posted.
    expect(octokit.__calls.createComment).toHaveLength(1);
  });

  it('does NOT apply labels when impactLabels is false even with a clear severity', async () => {
    const octokit = makeOctokit();
    const callApi = vi.fn(async () => '🔴 critical');
    await handleImpactCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm', impactLabels: false, impactLabelMap: labelMap },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });
    expect(octokit.__calls.addLabels).toHaveLength(0);
  });

  // CMD-5: the previous prefix-based removal (`zai:`) broke for label maps
  // whose values do NOT share a common `prefix:`. With a flat value set
  // (P0/P1/P2/P3), the handler must still remove prior managed labels.
  it('CMD-5: removes prior managed labels for non-`prefix:` label maps', async () => {
    const flatLabelMap = {
      critical: 'P0', high: 'P1', medium: 'P2', low: 'P3',
    };
    const octokit = makeOctokit({ labels: [{ name: 'P0' }, { name: 'P1' }] });
    const callApi = vi.fn(async () => '🟡 medium\n...');
    await handleImpactCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm', impactLabels: true, impactLabelMap: flatLabelMap },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });
    // Both prior managed labels (P0, P1) removed; P2 added.
    const removed = octokit.__calls.removeLabel.map((c) => c.name).sort();
    expect(removed).toEqual(['P0', 'P1']);
    expect(octokit.__calls.addLabels[0].labels).toEqual(['P2']);
  });

  it('CMD-5: still leaves non-managed (human) labels alone with flat label map', async () => {
    const flatLabelMap = {
      critical: 'P0', high: 'P1', medium: 'P2', low: 'P3',
    };
    const octokit = makeOctokit({ labels: [{ name: 'bug' }, { name: 'P0' }] });
    const callApi = vi.fn(async () => '🟢 low');
    await handleImpactCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm', impactLabels: true, impactLabelMap: flatLabelMap },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });
    // Only the managed P0 is removed; human "bug" label is untouched.
    const removed = octokit.__calls.removeLabel.map((c) => c.name);
    expect(removed).toEqual(['P0']);
    expect(octokit.__calls.addLabels[0].labels).toEqual(['P3']);
  });

  /* ---------- W19-E2-3: null severity never deletes human labels ---------- */

  // W19-E2-3: the W18-D3-2 null-severity removal deleted labels under the
  // CONFIGURED map — with a flat map (P0..P3), an unparseable assessment
  // REMOVED a human triager's P2: destructive mutation of labels the bot
  // can't prove it applied. On null severity, removal is restricted to the
  // bot's default-managed `zai:` namespace ONLY; with a custom flat map
  // nothing is removed and a warning explains why.
  it('W19-E2-3: custom flat map + null severity + human P2 → NO removeLabel, warning logged', async () => {
    const flatLabelMap = {
      critical: 'P0', high: 'P1', medium: 'P2', low: 'P3',
    };
    const octokit = makeOctokit({ labels: [{ name: 'P2' }] });
    const core = { info: vi.fn(), warning: vi.fn() };
    const callApi = vi.fn(async () => 'I cannot assess the impact of these changes.');
    await handleImpactCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm', impactLabels: true, impactLabelMap: flatLabelMap },
      commenter: { login: 'a' },
      args: '',
      callApi,
      core,
    });
    // The human triager's P2 is NEVER removed by an unparseable assessment…
    expect(octokit.__calls.removeLabel).toHaveLength(0);
    expect(octokit.__calls.addLabels).toHaveLength(0);
    // …and the decline is visible in the log.
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('assessment unparseable; leaving labels unchanged'),
    );
    // The assessment comment still posted.
    expect(octokit.__calls.createComment).toHaveLength(1);
  });

  it('W19-E2-3: default zai: map + null severity → zai:high removed, human P2 untouched (W18-D3-2 preserved)', async () => {
    const octokit = makeOctokit({ labels: [{ name: 'zai:high' }, { name: 'P2' }] });
    const core = { info: vi.fn(), warning: vi.fn() };
    const callApi = vi.fn(async () => 'No severity keyword here.');
    await handleImpactCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm', impactLabels: true, impactLabelMap: labelMap },
      commenter: { login: 'a' },
      args: '',
      callApi,
      core,
    });
    // The bot's own namespace is still cleaned up (stale zai:high removed)…
    expect(octokit.__calls.removeLabel).toHaveLength(1);
    expect(octokit.__calls.removeLabel[0].name).toBe('zai:high');
    // …nothing added, and the human P2 label is untouched.
    expect(octokit.__calls.addLabels).toHaveLength(0);
  });

  it('W19-E2-3: normal severity path unchanged for the flat map (add + remove managed)', async () => {
    // Guard: the null-severity restriction must not weaken the NORMAL path —
    // a parsed severity still swaps managed labels for a flat map.
    const flatLabelMap = {
      critical: 'P0', high: 'P1', medium: 'P2', low: 'P3',
    };
    const octokit = makeOctokit({ labels: [{ name: 'P3' }, { name: 'P2' }] });
    const callApi = vi.fn(async () => '🔴 critical\nhuge blast radius');
    await handleImpactCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm', impactLabels: true, impactLabelMap: flatLabelMap },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });
    const removed = octokit.__calls.removeLabel.map((c) => c.name).sort();
    expect(removed).toEqual(['P2', 'P3']);
    expect(octokit.__calls.addLabels[0].labels).toEqual(['P0']);
  });
});

/* ------------------------------------------------------------------ *
 * W15-A4-2: fail-soft opt-in mutation
 *
 * The label application used to share the outer catch with callApi, so an
 * issues.addLabels failure posted a FALSE "> ⚠️ Z.ai request failed." comment
 * AFTER the assessment had already been posted (two comments, the second
 * misleading). Per SECURITY.md's fail-soft write-surfaces contract, a
 * mutation failure must only core.warning — the assessment comment remains
 * the only comment.
 * ------------------------------------------------------------------ */

describe('handleImpactCommand — W15-A4-2: label-application failure is fail-soft', () => {
  const labelMap = {
    critical: 'zai:critical', high: 'zai:high', medium: 'zai:medium', low: 'zai:low',
  };

  it('addLabels rejects → exactly ONE comment (the assessment), no false "request failed"', async () => {
    const octokit = makeOctokit();
    octokit.rest.issues.addLabels = async () => {
      throw new Error('403 Resource not accessible');
    };
    const core = { info: vi.fn(), warning: vi.fn() };
    const callApi = vi.fn(async () => '🟡 medium\nassessment body');

    await handleImpactCommand({
      octokit,
      context: makeContext(),
      config: { apiKey: 'k', model: 'm', impactLabels: true, impactLabelMap: labelMap },
      commenter: { login: 'a' },
      args: '',
      callApi,
      core,
    });

    // The assessment comment is the ONLY comment — no false error follow-up.
    expect(octokit.__calls.createComment).toHaveLength(1);
    const body = octokit.__calls.createComment[0].body;
    expect(body).toContain('assessment body');
    expect(body).not.toContain('request failed');
    // The mutation failure was logged as a warning (fail-soft write surface).
    expect(core.warning).toHaveBeenCalled();
  });
});

describe('handleImpactCommand — error path', () => {
  it('callApi rejects → short error comment, no throw', async () => {
    const octokit = makeOctokit();
    const core = { info: vi.fn(), warning: vi.fn() };
    const callApi = vi.fn(async () => {
      throw new Error('timeout');
    });
    await expect(
      handleImpactCommand({
        octokit,
        context: makeContext(),
        config: { apiKey: 'k', model: 'm' },
        commenter: { login: 'a' },
        args: '',
        callApi,
        core,
      }),
    ).resolves.toBeUndefined();
    const body = octokit.__calls.createComment[0].body;
    expect(body).toContain('Z.ai request failed');
    expect(body).not.toContain('timeout');
    expect(core.warning).toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * parseSeverity — negation stripping & precedence (Task 11 edge cases)
 *
 * The parser strips common negation prefixes (non-, not, no, isn't, aren't,
 * without) before matching severity words, so a negated severity does not
 * false-positive into a label. These tests pin that behavior explicitly.
 * ------------------------------------------------------------------ */

describe('parseSeverity — negation stripping (edge cases)', () => {
  it('"non-critical" does NOT yield "critical"', () => {
    expect(parseSeverity('non-critical')).toBeNull();
  });

  it('"not high" does NOT yield "high"', () => {
    expect(parseSeverity('not high')).toBeNull();
  });

  it("\"isn't high\" does NOT yield \"high\"", () => {
    expect(parseSeverity("isn't high")).toBeNull();
  });

  it('"no critical issues" does NOT yield "critical"', () => {
    expect(parseSeverity('no critical issues')).toBeNull();
  });

  it('negation inside a longer sentence is still stripped', () => {
    // The negation guard must work mid-sentence, not just on a bare phrase.
    expect(parseSeverity('This is a non-critical change but worth noting.')).toBeNull();
    expect(parseSeverity('There are no critical issues here.')).toBeNull();
    expect(parseSeverity('The risk is not high overall.')).toBeNull();
  });
});

describe('parseSeverity — positive matches (edge cases)', () => {
  it('plain "critical" → "critical"', () => {
    expect(parseSeverity('critical')).toBe('critical');
  });

  it('plain "high" → "high"', () => {
    expect(parseSeverity('high')).toBe('high');
  });
});

describe('parseSeverity — precedence (edge cases)', () => {
  it('"critical" is checked before "high" — "critical and high" → "critical"', () => {
    // The priority order is critical → high → medium → low. When both
    // keywords appear, the most severe must win.
    expect(parseSeverity('critical and high')).toBe('critical');
  });
});

/* ------------------------------------------------------------------ *
 * W15-A4-3: the declared EMOJI is canonical
 *
 * The interleaved priority loop (🔴, critical, 🟠, high, …) let a stray
 * higher-severity WORD override the declared emoji: '🟡 medium — not in the
 * critical path' matched the word 'critical' first and produced the wrong
 * zai:critical label. The prompt requests the emoji form, so all four emoji
 * must be checked FIRST; word-forms are only a fallback when no emoji is on
 * the first line.
 * ------------------------------------------------------------------ */

describe('parseSeverity — W15-A4-3: emoji takes precedence over stray words', () => {
  it('declared emoji wins over a stray higher-severity word on the same line', () => {
    expect(parseSeverity('🟡 medium — not in the critical path')).toBe('medium');
    expect(parseSeverity('🟠 high — fixes a critical auth bug')).toBe('high');
    expect(parseSeverity('🟢 low — avoid a critical-sounding false alarm')).toBe('low');
  });

  it('word-form still maps when NO emoji is on the first line', () => {
    expect(parseSeverity('Critical issue in the auth flow')).toBe('critical');
    expect(parseSeverity('low risk overall')).toBe('low');
  });

  it('negated words still do not match when no emoji is present', () => {
    expect(parseSeverity('not critical')).toBeNull();
    expect(parseSeverity('no high risks')).toBeNull();
  });
});

describe('parseSeverity — case-insensitive matching (edge cases)', () => {
  it('"CRITICAL" (all caps) → "critical"', () => {
    expect(parseSeverity('CRITICAL')).toBe('critical');
  });

  it('"Critical" (title case) → "critical"', () => {
    expect(parseSeverity('Critical')).toBe('critical');
  });

  it('"HiGh" (mixed case) → "high"', () => {
    expect(parseSeverity('HiGh')).toBe('high');
  });
});

/* ------------------------------------------------------------------ *
 * W15-A4-4 (impact copy): oversized entries are SKIPPED, not fatal.
 * See tests/handlers/ask.test.js for the full rationale — impact.js carries
 * an identical buildDiffContext.
 * ------------------------------------------------------------------ */

describe('buildDiffContext — W15-A4-4: oversized entries skipped, not fatal', () => {
  it('big-first: later small entries still make it into the context', () => {
    const files = [
      { filename: 'big.js', patch: 'x'.repeat(9000) },
      { filename: 'small.js', patch: '+tiny change' },
    ];
    const context = buildDiffContext(files);
    expect(context).toContain('small.js');
    expect(context).toContain('+tiny change');
  });

  it('all entries oversized → budget-exceeded placeholder, not a false no-diffs claim', () => {
    const files = [
      { filename: 'big1.js', patch: 'x'.repeat(9000) },
      { filename: 'big2.js', patch: 'y'.repeat(9000) },
    ];
    const context = buildDiffContext(files);
    expect(context).toContain('budget');
    expect(context).not.toContain('no textual diffs');
  });
});

/* ------------------------------------------------------------------ *
 * W16-B4-4 (impact copy): excluded files dropped BEFORE the diff budget.
 * impact.js carries an identical buildDiffContext; the same fix applies —
 * filterExcludedFiles BEFORE filterPatchableFiles, mirroring review.js's
 * W15-A8-8 fix. See tests/handlers/ask.test.js for the full rationale.
 * ------------------------------------------------------------------ */

const DEFAULT_EXCLUDES = [
  '*.lock',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
];

describe('buildDiffContext — W16-B4-4 (impact): excluded files dropped before the budget', () => {
  const files = () => [
    { filename: 'package-lock.json', status: 'modified', patch: `+lock ${'x'.repeat(7900)}` },
    { filename: 'src/auth.js', status: 'modified', patch: '+auth change' },
  ];

  it('default excludes: lockfile dropped, src/auth.js visible in the context', () => {
    const context = buildDiffContext(files(), undefined, DEFAULT_EXCLUDES);
    expect(context).toContain('src/auth.js');
    expect(context).not.toContain('package-lock.json');
  });

  it('custom excludePatterns are respected', () => {
    const context = buildDiffContext(files(), undefined, ['src/**']);
    expect(context).toContain('package-lock.json');
    expect(context).not.toContain('src/auth.js');
  });

  it('no excludes at all → all patchable files included (consistent with review.js)', () => {
    const context = buildDiffContext(files());
    expect(context).toContain('package-lock.json');
    expect(context).toContain('src/auth.js');
  });
});

describe('handleImpactCommand — W16-B4-4: threads config.excludePatterns', () => {
  it('default excludes: prompt contains src/auth.js, NOT the lockfile', async () => {
    const octokit = makeOctokit({
      files: [
        { filename: 'package-lock.json', status: 'modified', patch: `+lock ${'x'.repeat(7900)}` },
        { filename: 'src/auth.js', status: 'modified', patch: '+auth change' },
      ],
    });
    const callApi = vi.fn(async () => '## Impact: 🟢 low\n...');

    await handleImpactCommand({
      octokit,
      context: makeContext(),
      config: {
        apiKey: 'k',
        model: 'm',
        excludePatterns: DEFAULT_EXCLUDES,
      },
      commenter: { login: 'a' },
      args: '',
      callApi,
    });

    expect(callApi).toHaveBeenCalledTimes(1);
    const prompt = callApi.mock.calls[0][2];
    expect(prompt).toContain('src/auth.js');
    expect(prompt).not.toContain('package-lock.json');
  });
});
