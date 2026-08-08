/**
 * Feature-tracker bug verification tests.
 *
 * Each test here corresponds to a confirmed bug documented in
 * `.zcode/feature-tracker.csv` (US-036, US-043, US-044, US-058, US-059).
 * Written BEFORE the fix (TDD red phase) to prove each bug exists, then the
 * fix flips it green. These are NOT speculative — each was verified against
 * the current production code.
 */
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/lib/config.js';
import { parseZaiYml, validateRepoConfig, mergeRepoConfig } from '../src/lib/repo-config.js';
import {
  runScheduledReview,
  hasReviewForSha,
  buildShaBlock,
  reviewOnePr,
  DEFAULT_MAX_PRS,
} from '../src/lib/schedule.js';
import { MARKER } from '../src/lib/comments.js';
import { formatFindingsAsSummary } from '../src/lib/findings.js';
import { buildCommentBody } from '../src/lib/comments.js';
import { makeFinding } from './_helpers.js';

/* ------------------------------------------------------------------ *
 * US-036: MAX_DIFF_CHARS negative handling is inconsistent with docs
 *
 * action.yml says "0 = unlimited" and the code comment says negatives are
 * treated as 0 (unlimited). The CODE treats negatives as 100000 (the
 * default cap). A user setting MAX_DIFF_CHARS: -1 expecting unlimited
 * silently gets the 100k cap. This is a logistical/doc bug.
 * ------------------------------------------------------------------ */
describe('US-036: MAX_DIFF_CHARS negative value handling', () => {
  it('treats 0 as unlimited (documented behavior)', () => {
    const cfg = loadConfig({ ZAI_API_KEY: 'k', MAX_DIFF_CHARS: '0' });
    expect(cfg.maxDiffChars).toBe(0);
  });

  it('treats a negative value as unlimited (regression: previously returned 100000)', () => {
    // Per action.yml + the code comment, negatives mean unlimited (0).
    // Previously the code returned 100000 for negatives (a doc/code mismatch);
    // this guards against that regression.
    const cfg = loadConfig({ ZAI_API_KEY: 'k', MAX_DIFF_CHARS: '-1' });
    expect(cfg.maxDiffChars).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * US-043: .zai.yml reviews.profile is validated then silently dropped
 *
 * The README example leads with `profile: chill` as if it changes review
 * behavior, but mergeRepoConfig never reads reviews.profile. This test
 * proves the field disappears during merge.
 * ------------------------------------------------------------------ */
describe('US-043: .zai.yml reviews.profile round-trips through merge', () => {
  it('profile is accepted by validateRepoConfig', () => {
    const parsed = parseZaiYml('reviews:\n  profile: chill\n');
    const validated = validateRepoConfig(parsed);
    expect(validated.reviews?.profile).toBe('chill');
  });

  it('profile survives mergeRepoConfig (previously dropped)', () => {
    const action = { apiKey: 'k', maxFindings: 8, excludePatterns: [] };
    const repo = validateRepoConfig(parseZaiYml('reviews:\n  profile: assertive\n'));
    const merged = mergeRepoConfig(action, repo);
    expect(merged.profile).toBe('assertive');
  });

  it('profile:chill narrows minSeverity to high (only critical+high surface)', () => {
    // README advertises chill as a working knob. After the fix it raises the
    // effective floor to `high` so only critical+high findings are reported.
    const action = { apiKey: 'k', maxFindings: 8, excludePatterns: [], minSeverity: 'info' };
    const repo = validateRepoConfig(parseZaiYml('reviews:\n  profile: chill\n'));
    const merged = mergeRepoConfig(action, repo);
    expect(merged.minSeverity).toBe('high');
  });

  it('profile:chill cannot WIDEN a stricter action floor (narrows only)', () => {
    // If the action already set minSeverity=critical, chill must not lower it.
    const action = { apiKey: 'k', maxFindings: 8, excludePatterns: [], minSeverity: 'critical' };
    const repo = validateRepoConfig(parseZaiYml('reviews:\n  profile: chill\n'));
    const merged = mergeRepoConfig(action, repo);
    expect(merged.minSeverity).toBe('critical');
  });

  it('profile:assertive leaves the action floor unchanged', () => {
    const action = { apiKey: 'k', maxFindings: 8, excludePatterns: [], minSeverity: 'low' };
    const repo = validateRepoConfig(parseZaiYml('reviews:\n  profile: assertive\n'));
    const merged = mergeRepoConfig(action, repo);
    expect(merged.minSeverity).toBe('low');
  });
});

/* ------------------------------------------------------------------ *
 * US-044: .zai.yml reviews.language is validated then silently dropped
 *
 * Parsed, validated, capped at 20 chars, then never used. Same shape as
 * US-043.
 * ------------------------------------------------------------------ */
describe('US-044: .zai.yml reviews.language round-trips through merge', () => {
  it('language is accepted by validateRepoConfig', () => {
    const parsed = parseZaiYml('reviews:\n  language: en-US\n');
    const validated = validateRepoConfig(parsed);
    expect(validated.reviews?.language).toBe('en-US');
  });

  it('language survives mergeRepoConfig (previously dropped)', () => {
    const action = { apiKey: 'k', maxFindings: 8, excludePatterns: [] };
    const repo = validateRepoConfig(parseZaiYml('reviews:\n  language: fr-FR\n'));
    const merged = mergeRepoConfig(action, repo);
    expect(merged.language).toBe('fr-FR');
  });

  it('language is folded into toneInstructions as a "Respond in <lang>" directive', () => {
    // README advertises language as a working knob. After the fix it adds a
    // response-language instruction to the additive tone context.
    const action = { apiKey: 'k', maxFindings: 8, excludePatterns: [] };
    const repo = validateRepoConfig(parseZaiYml('reviews:\n  language: 日本語\n'));
    const merged = mergeRepoConfig(action, repo);
    expect(merged.toneInstructions).toContain('Respond in 日本語.');
  });

  it('language combines with explicit tone_instructions', () => {
    const action = { apiKey: 'k', maxFindings: 8, excludePatterns: [] };
    const repo = validateRepoConfig(
      parseZaiYml('reviews:\n  tone_instructions: "Be terse."\n  language: fr-FR\n'),
    );
    const merged = mergeRepoConfig(action, repo);
    expect(merged.toneInstructions).toContain('Be terse.');
    expect(merged.toneInstructions).toContain('Respond in fr-FR.');
  });
});

/* ------------------------------------------------------------------ *
 * US-058: Scheduled review dedup-by-SHA never matches production bodies
 *
 * hasReviewForSha looks for a bot comment whose body contains BOTH the
 * marker AND the head SHA. But the review body built by the production
 * pipeline (formatFindingsAsSummary + buildCommentBody) NEVER embeds the
 * SHA — only the fixed marker literal. So in production a stable PR is
 * re-reviewed on EVERY cron tick, defeating the "only new/changed PRs"
 * guarantee. The existing unit tests pass only because they hand-craft
 * bodies that include the SHA, which production never does.
 *
 * This test reproduces the real production body shape and asserts the
 * dedup SHOULD recognize it.
 * ------------------------------------------------------------------ */
describe('US-058: scheduled dedup recognizes production review bodies', () => {
  // Build the EXACT body shape the summary-comment path produces.
  const findings = [makeFinding()];
  const content = formatFindingsAsSummary(findings, { reviewerName: 'Z.ai Code Review' });
  const productionBody = buildCommentBody({
    title: 'Z.ai Code Review',
    content,
    marker: MARKER,
  });

  it('production body contains the marker', () => {
    expect(productionBody).toContain(MARKER);
  });

  it('production body does NOT embed the head SHA (the root cause)', () => {
    // This documents the gap: the body has no SHA for hasReviewForSha to match.
    expect(productionBody).not.toContain('deadbeef');
  });

  it('hasReviewForSha recognizes a production-shaped body when SHA is appended', async () => {
    // After the fix, the production body WILL carry the SHA. Simulate that.
    const sha = 'deadbeefcafebabe';
    const fixedBody = `${productionBody}\n<!-- zai-sha: ${sha} -->`;
    const octokit = {
      rest: {
        issues: {
          async listComments() {
            return {
              data: [
                {
                  body: fixedBody,
                  user: { login: 'github-actions[bot]', type: 'Bot' },
                },
              ],
            };
          },
        },
      },
    };
    const found = await hasReviewForSha({
      octokit,
      owner: 'o',
      repo: 'r',
      pullNumber: 1,
      headSha: sha,
    });
    expect(found).toBe(true);
  });

  it('hasReviewForSha returns FALSE for a bare production body (no SHA block)', async () => {
    // A body WITHOUT the SHA block (e.g. a legacy review from before the fix)
    // must not be falsely matched. This guards against false-positive dedup.
    const sha = 'deadbeefcafebabe';
    const octokit = {
      rest: {
        issues: {
          async listComments() {
            return {
              data: [
                {
                  body: productionBody,
                  user: { login: 'github-actions[bot]', type: 'Bot' },
                },
              ],
            };
          },
        },
      },
    };
    const found = await hasReviewForSha({
      octokit,
      owner: 'o',
      repo: 'r',
      pullNumber: 1,
      headSha: sha,
    });
    expect(found).toBe(false);
  });

  it('buildShaBlock embeds the SHA in a hidden comment', () => {
    expect(buildShaBlock('abc123')).toBe('<!-- zai-sha: abc123 -->');
    expect(buildShaBlock('')).toBe('');
    expect(buildShaBlock(undefined)).toBe('');
  });

  it('reviewOnePr posts a summary-comment body containing the head SHA', async () => {
    // The fix: reviewOnePr appends buildShaBlock(sha) to the posted body so
    // hasReviewForSha recognizes it next tick. Verify end-to-end via the
    // summary-comment path (no inline findings → upsertReviewComment).
    const sha = 'feedface';
    let postedBody = null;
    const octokit = {
      rest: {
        issues: {
          async createComment(p) {
            postedBody = p.body;
            return { data: { id: 1 } };
          },
          async listComments() {
            return { data: [] };
          },
        },
      },
    };
    await reviewOnePr({
      pr: { number: 7, headSha: sha, draft: false, title: 't' },
      octokit,
      owner: 'o',
      repo: 'r',
      config: { reviewerName: 'Z.ai Code Review', excludePatterns: [] },
      core: { info: () => {}, warning: () => {} },
      callApi: async () => '{"summary":"","findings":[]}',
      getChangedFiles: async () => [{ filename: 'a.js', patch: '+a' }],
      filterExcludedFiles: (f) => f,
      filterPatchableFiles: (f) => f,
      runStructuredReview: async () => ({
        findings: [],
        summary: 'clean',
        metadata: { deterministicFindingsCount: 0, totalFindingsBeforeCap: 0 },
      }),
      isLargePr: () => false,
      formatFindingsAsSummary: (findings) =>
        `## Z.ai Code Review\n\n${findings.length} finding(s)\n\n${MARKER}`,
      buildCommentBody: ({ content }) => content,
      upsertReviewComment: async ({ body }) => {
        postedBody = body;
      },
      partitionFindings: () => ({ inline: [], summaryOnly: [] }),
      buildReviewBody: () => '',
      buildReviewComments: () => [],
      upsertReview: async () => {},
      postFallbackComment: async () => {},
      resolveReviewEvent: () => 'COMMENT',
    });
    expect(postedBody).toContain(MARKER);
    expect(postedBody).toContain(sha);
    expect(postedBody).toContain(`<!-- zai-sha: ${sha} -->`);
  });
});

/* ------------------------------------------------------------------ *
 * US-059: ZAI_SCHEDULE_MAX_PRS is silently clamped to the default (10)
 *
 * runScheduledReview computes cap = Math.min(config.scheduleMaxPrs, maxPrs)
 * where maxPrs defaults to DEFAULT_MAX_PRS (10). The caller in index.js
 * does NOT pass maxPrs, so an operator who sets ZAI_SCHEDULE_MAX_PRS=50
 * gets at most 10 PRs reviewed. The config knob is silently ignored
 * above the default.
 * ------------------------------------------------------------------ */
describe('US-059: ZAI_SCHEDULE_MAX_PRS honored above the default', () => {
  function makeDeps({ prs }) {
    const octokit = {
      rest: {
        pulls: {
          async list() {
            return { data: prs };
          },
        },
        issues: {
          async listComments() {
            return { data: [] };
          },
        },
      },
    };
    return octokit;
  }

  it('config.scheduleMaxPrs=25 reviews up to 25 PRs (regression: was clamped to default 10)', async () => {
    const prs = Array.from({ length: 25 }, (_, i) => ({
      number: i + 1,
      head: { sha: `sha-${i}` },
      draft: false,
      title: 'p',
    }));
    const octokit = makeDeps({ prs });
    let reviewed = 0;
    const result = await runScheduledReview({
      octokit,
      owner: 'o',
      repo: 'r',
      config: { scheduleMaxPrs: 25, reviewerName: 'Z.ai Code Review', excludePatterns: [] },
      core: { info: () => {}, warning: () => {} },
      callApi: async () => '{}',
      // Stub the heavy pipeline so reviewOnePr short-circuits on zero patchable.
      getChangedFiles: async () => [],
      filterExcludedFiles: (f) => f,
      filterPatchableFiles: () => [],
      runStructuredReview: async () => ({ findings: [], summary: '', metadata: {} }),
      isLargePr: () => false,
      formatFindingsAsSummary: () => '',
      buildCommentBody: () => '',
      upsertReviewComment: async () => {},
      partitionFindings: () => ({ inline: [], summaryOnly: [] }),
      buildReviewBody: () => '',
      buildReviewComments: () => [],
      upsertReview: async () => {},
      postFallbackComment: async () => {},
      resolveReviewEvent: () => 'COMMENT',
      // NOTE: maxPrs intentionally NOT passed, mirroring src/index.js.
    });
    // 25 PRs considered (reviewed=25 since all short-circuit to
    // skipped-no-patchable which counts as ok). Previously the default maxPrs
    // (10) silently clamped this to 10; this guards against that regression.
    expect(result.reviewed).toBe(25);
  });
});
