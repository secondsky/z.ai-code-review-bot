/**
 * Tests for src/lib/status.js — commit-status feedback (pending → success/failure).
 *
 * Octokit and `core`-like logger are INJECTED — never imported at module load —
 * so this module stays pure and unit-testable. Every external collaborator is a
 * stub that records calls, so no network/GitHub is touched.
 */
import {
  setReviewStatus,
  buildStatusDescription,
  STATUS_CONTEXT,
} from '../src/lib/status.js';

/* ------------------------------------------------------------------ *
 * Fake octokit / core
 * ------------------------------------------------------------------ */

/**
 * Build a fake octokit whose `rest.repos.createCommitStatus` records every
 * call. Pass `throwOnCreate` (an Error) to exercise the fail-soft path.
 */
function makeOctokit({ throwOnCreate = null } = {}) {
  const calls = { createCommitStatus: [] };
  const octokit = {
    rest: {
      repos: {
        async createCommitStatus(params) {
          calls.createCommitStatus.push(params);
          if (throwOnCreate) throw throwOnCreate;
          return { data: { id: 1, ...params } };
        },
      },
    },
  };
  return { octokit, calls };
}

/** Build a fake core capturing warning calls. */
function makeCore() {
  const warnings = [];
  return {
    core: { warning: (m) => warnings.push(m) },
    warnings,
  };
}

/** A standard pull_request context with a head sha. */
function makeContext({ owner = 'owner', repo = 'repo' } = {}) {
  return { repo: { owner, repo } };
}

/* ------------------------------------------------------------------ *
 * STATUS_CONTEXT
 * ------------------------------------------------------------------ */

describe('STATUS_CONTEXT', () => {
  test('is the fixed "Z.ai Code Review" label', () => {
    expect(STATUS_CONTEXT).toBe('Z.ai Code Review');
  });
});

/* ------------------------------------------------------------------ *
 * buildStatusDescription
 * ------------------------------------------------------------------ */

describe('buildStatusDescription', () => {
  test('no findings → "Review complete: no issues found ✅"', () => {
    expect(
      buildStatusDescription({ findingCount: 0, criticalCount: 0, highCount: 0 }),
    ).toBe('Review complete: no issues found ✅');
  });

  test('findings present → "Review complete: N findings (M critical, H high)"', () => {
    expect(
      buildStatusDescription({ findingCount: 5, criticalCount: 1, highCount: 2 }),
    ).toBe('Review complete: 5 findings (1 critical, 2 high)');
  });

  test('findings present, zero critical/high', () => {
    expect(
      buildStatusDescription({ findingCount: 3, criticalCount: 0, highCount: 0 }),
    ).toBe('Review complete: 3 findings (0 critical, 0 high)');
  });

  test('singular-like counts still use plural noun ("1 findings") for stable wording', () => {
    // The format is fixed ("findings"); the count is interpolated. Keep it
    // simple — GitHub descriptions are short-lived.
    expect(
      buildStatusDescription({ findingCount: 1, criticalCount: 1, highCount: 0 }),
    ).toBe('Review complete: 1 findings (1 critical, 0 high)');
  });

  test('missing counts default to 0 (defensive)', () => {
    expect(buildStatusDescription({})).toBe('Review complete: no issues found ✅');
  });

  test('only findingCount set (critical/high default 0)', () => {
    expect(
      buildStatusDescription({ findingCount: 2 }),
    ).toBe('Review complete: 2 findings (0 critical, 0 high)');
  });
});

/* ------------------------------------------------------------------ *
 * setReviewStatus
 * ------------------------------------------------------------------ */

describe('setReviewStatus — success path', () => {
  test('calls createCommitStatus with the correct payload and returns true', async () => {
    const { octokit, calls } = makeOctokit();
    const context = makeContext();

    const ok = await setReviewStatus({
      octokit,
      context,
      sha: 'abc123',
      state: 'pending',
      description: 'Z.ai review in progress…',
    });

    expect(ok).toBe(true);
    expect(calls.createCommitStatus).toHaveLength(1);
    expect(calls.createCommitStatus[0]).toEqual({
      owner: 'owner',
      repo: 'repo',
      sha: 'abc123',
      state: 'pending',
      description: 'Z.ai review in progress…',
      context: 'Z.ai Code Review',
      target_url: undefined,
    });
  });

  test('uses STATUS_CONTEXT label for the GitHub status context', async () => {
    const { octokit, calls } = makeOctokit();
    await setReviewStatus({
      octokit,
      context: makeContext(),
      sha: 'abc123',
      state: 'success',
      description: 'done',
    });
    expect(calls.createCommitStatus[0].context).toBe(STATUS_CONTEXT);
  });

  test('passes target_url through when provided', async () => {
    const { octokit, calls } = makeOctokit();
    await setReviewStatus({
      octokit,
      context: makeContext(),
      sha: 'abc123',
      state: 'success',
      description: 'done',
      targetUrl: 'https://example.com/run/1',
    });
    expect(calls.createCommitStatus[0].target_url).toBe('https://example.com/run/1');
  });

  test('passes target_url as undefined when not provided', async () => {
    // The implementation always sets `target_url` (to the value or undefined);
    // GitHub treats an undefined/null target_url as "no link", which is fine.
    const { octokit, calls } = makeOctokit();
    await setReviewStatus({
      octokit,
      context: makeContext(),
      sha: 'abc123',
      state: 'failure',
      description: 'bad',
    });
    expect(calls.createCommitStatus[0].target_url).toBeUndefined();
  });
});

describe('setReviewStatus — fail-soft on API error', () => {
  test('returns false and warns (never throws) when createCommitStatus throws', async () => {
    const { octokit } = makeOctokit({
      throwOnCreate: new Error('Bad credentials'),
    });
    const { core, warnings } = makeCore();

    const ok = await setReviewStatus(
      {
        octokit,
        context: makeContext(),
        sha: 'abc123',
        state: 'pending',
        description: 'starting',
      },
      { core },
    );

    expect(ok).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Bad credentials');
  });

  test('does NOT throw when core is omitted (still returns false)', async () => {
    const { octokit } = makeOctokit({
      throwOnCreate: new Error('oops'),
    });
    // No deps → must not throw even though there is no logger.
    await expect(
      setReviewStatus({
        octokit,
        context: makeContext(),
        sha: 'abc123',
        state: 'pending',
        description: 'starting',
      }),
    ).resolves.toBe(false);
  });

  test('works with empty deps default (no core) on success', async () => {
    const { octokit } = makeOctokit();
    const ok = await setReviewStatus({
      octokit,
      context: makeContext(),
      sha: 'abc123',
      state: 'success',
      description: 'done',
    });
    expect(ok).toBe(true);
  });
});

describe('setReviewStatus — description truncation', () => {
  test('description > 140 chars is truncated to 140 (GitHub limit)', async () => {
    const { octokit, calls } = makeOctokit();
    const long = 'x'.repeat(200);
    await setReviewStatus({
      octokit,
      context: makeContext(),
      sha: 'abc123',
      state: 'success',
      description: long,
    });
    expect(calls.createCommitStatus[0].description.length).toBe(140);
    expect(calls.createCommitStatus[0].description).toBe('x'.repeat(140));
  });

  test('description exactly 140 chars is NOT truncated', async () => {
    const { octokit, calls } = makeOctokit();
    const exact = 'y'.repeat(140);
    await setReviewStatus({
      octokit,
      context: makeContext(),
      sha: 'abc123',
      state: 'success',
      description: exact,
    });
    expect(calls.createCommitStatus[0].description).toBe(exact);
    expect(calls.createCommitStatus[0].description.length).toBe(140);
  });

  test('description < 140 chars is passed through unchanged', async () => {
    const { octokit, calls } = makeOctokit();
    await setReviewStatus({
      octokit,
      context: makeContext(),
      sha: 'abc123',
      state: 'success',
      description: 'short',
    });
    expect(calls.createCommitStatus[0].description).toBe('short');
  });
});

describe('setReviewStatus — missing inputs (graceful)', () => {
  test('missing sha → returns false (no API call)', async () => {
    const { octokit, calls } = makeOctokit();
    const ok = await setReviewStatus({
      octokit,
      context: makeContext(),
      sha: '',
      state: 'pending',
      description: 'starting',
    });
    expect(ok).toBe(false);
    expect(calls.createCommitStatus).toHaveLength(0);
  });

  test('missing context.repo → returns false (no API call)', async () => {
    const { octokit, calls } = makeOctokit();
    const ok = await setReviewStatus({
      octokit,
      context: { payload: {} },
      sha: 'abc123',
      state: 'pending',
      description: 'starting',
    });
    expect(ok).toBe(false);
    expect(calls.createCommitStatus).toHaveLength(0);
  });

  test('missing octokit → returns false gracefully (no throw)', async () => {
    const ok = await setReviewStatus({
      context: makeContext(),
      sha: 'abc123',
      state: 'pending',
      description: 'starting',
    });
    expect(ok).toBe(false);
  });

  test('missing sha AND missing core → returns false (no throw)', async () => {
    const { octokit } = makeOctokit();
    await expect(
      setReviewStatus({
        octokit,
        context: makeContext(),
        sha: '',
        state: 'pending',
        description: 'starting',
      }),
    ).resolves.toBe(false);
  });
});
