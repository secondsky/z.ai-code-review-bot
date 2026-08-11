/**
 * Tests for src/lib/changed-files.js — paginated PR file fetch + pure filters.
 *
 * Octokit is injected (parameter), never imported. `filterExcludedFiles`
 * exercises the REAL `matchesAnyPattern` from `./glob.js`.
 */
import { getChangedFiles, filterPatchableFiles, filterExcludedFiles } from '../src/lib/changed-files.js';

/* ---------- Fake octokit helper ---------- */

/**
 * Build a fake octokit whose `rest.pulls.listFiles` returns the configured
 * pages in order. Captures each call so we can assert pagination params.
 */
function makePagesOctokit(pages) {
  const calls = [];
  let i = 0;
  const octokit = {
    rest: {
      pulls: {
        async listFiles(params) {
          calls.push(params);
          const page = pages[i++] ?? [];
          return { data: page };
        },
      },
    },
  };
  return { octokit, calls };
}

function makeFile(filename, status, patch) {
  return { filename, status, patch };
}

describe('getChangedFiles', () => {
  test('paginates: page1 (full) then page2 (short) — concatenates results', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => makeFile(`a${i}.js`, 'modified', '@@'));
    const page2 = [makeFile('last.js', 'added', '@@')];
    const { octokit, calls } = makePagesOctokit([page1, page2]);

    const result = await getChangedFiles({
      octokit,
      owner: 'o',
      repo: 'r',
      pullNumber: 5,
      perPage: 100,
    });

    expect(result).toHaveLength(101);
    expect(result[0].filename).toBe('a0.js');
    expect(result[100].filename).toBe('last.js');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      owner: 'o',
      repo: 'r',
      pull_number: 5,
      per_page: 100,
      page: 1,
    });
    expect(calls[1]).toEqual({
      owner: 'o',
      repo: 'r',
      pull_number: 5,
      per_page: 100,
      page: 2,
    });
  });

  test('single page: data.length < perPage on first call', async () => {
    const page1 = [makeFile('only.js', 'modified', '@@')];
    const { octokit, calls } = makePagesOctokit([page1]);

    const result = await getChangedFiles({ octokit, owner: 'o', repo: 'r', pullNumber: 1 });

    expect(result).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].page).toBe(1);
  });

  test('exactly perPage on first call, empty second page — two calls', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => makeFile(`f${i}.js`, 'added', '@@'));
    const page2 = [];
    const { octokit, calls } = makePagesOctokit([page1, page2]);

    const result = await getChangedFiles({
      octokit,
      owner: 'o',
      repo: 'r',
      pullNumber: 9,
      perPage: 50,
    });

    expect(result).toHaveLength(50);
    expect(calls).toHaveLength(2);
    expect(calls[0].page).toBe(1);
    expect(calls[1].page).toBe(2);
  });

  test('defaults perPage to 100', async () => {
    const { octokit, calls } = makePagesOctokit([[makeFile('a.js', 'added', '@@')]]);
    await getChangedFiles({ octokit, owner: 'o', repo: 'r', pullNumber: 1 });
    expect(calls[0].per_page).toBe(100);
  });

  test('includes files with no patch (binary / unrendered diffs)', async () => {
    const page1 = [
      makeFile('bin.png', 'added', undefined),
      makeFile('code.js', 'modified', '@@'),
    ];
    const { octokit } = makePagesOctokit([page1]);

    const result = await getChangedFiles({ octokit, owner: 'o', repo: 'r', pullNumber: 1 });

    expect(result).toHaveLength(2);
    expect(result.find((f) => f.filename === 'bin.png').patch).toBeUndefined();
  });

  test('BUG4: pagination caps at MAX_FILES — a runaway PR does not fetch forever', async () => {
    // Every page returns a full page, so without a cap the loop would never
    // terminate. The cap must stop fetching once MAX_FILES is reached.
    const fullPage = Array.from({ length: 100 }, (_, i) => makeFile(`f${i}.js`, 'modified', '@@'));
    // makePagesOctokit returns the same array reference each call; we want it
    // to keep returning full pages forever.
    const infiniteOctokit = {
      rest: {
        pulls: {
          async listFiles() {
            return { data: fullPage };
          },
        },
      },
    };

    const result = await getChangedFiles({
      octokit: infiniteOctokit,
      owner: 'o',
      repo: 'r',
      pullNumber: 1,
      perPage: 100,
    });

    // Cap must be a finite ceiling well below "infinite". The exact value is
    // MAX_FILES (3000) — assert it is bounded and reasonable.
    expect(result.length).toBeLessThanOrEqual(3000);
    expect(result.length).toBeGreaterThan(100); // it did fetch more than one page
  });

  test('BUG4: pagination caps at MAX_PAGES — does not run past 100 pages', async () => {
    // Use a tiny perPage so many pages are needed; ensure we stop well before
    // the page count grows without bound even if every page is full.
    const fullPage = Array.from({ length: 5 }, (_, i) => makeFile(`f${i}.js`, 'modified', '@@'));
    const calls = [];
    let i = 0;
    const octokit = {
      rest: {
        pulls: {
          async listFiles(params) {
            calls.push(params);
            return { data: fullPage };
          },
        },
      },
    };

    const result = await getChangedFiles({
      octokit,
      owner: 'o',
      repo: 'r',
      pullNumber: 1,
      perPage: 5,
    });

    // With MAX_PAGES=100 and MAX_FILES=3000, and pages of 5, the file cap
    // (3000) would be hit at 600 pages — but the page cap (100) hits first.
    expect(calls.length).toBeLessThanOrEqual(100);
    expect(result.length).toBeLessThanOrEqual(3000);
  });
});

describe('filterPatchableFiles', () => {
  test('keeps only files with a non-empty string patch', () => {
    const files = [
      makeFile('a.js', 'modified', '@@ diff @@'),
      makeFile('b.png', 'added', undefined),
      makeFile('c.js', 'added', ''),
      makeFile('d.js', 'modified', '@@ other @@'),
    ];
    const out = filterPatchableFiles(files);
    expect(out.map((f) => f.filename)).toEqual(['a.js', 'd.js']);
  });

  test('defensive: tolerates nullish entries and non-string patch', () => {
    const out = filterPatchableFiles([null, undefined, { filename: 'x' }]);
    expect(out).toEqual([]);
  });

  test('returns empty array for empty input', () => {
    expect(filterPatchableFiles([])).toEqual([]);
  });
});

describe('filterExcludedFiles', () => {
  test('drops files matching exclude patterns (real glob matching)', () => {
    const files = [{ filename: 'a.lock' }, { filename: 'src/b.js' }];
    const out = filterExcludedFiles(files, ['*.lock']);
    expect(out).toEqual([{ filename: 'src/b.js' }]);
  });

  test('keeps everything when excludePatterns is empty', () => {
    const files = [{ filename: 'a' }, { filename: 'b' }];
    expect(filterExcludedFiles(files, [])).toEqual(files);
  });

  test('supports directory globs', () => {
    const files = [
      { filename: 'dist/x.js' },
      { filename: 'src/y.js' },
      { filename: 'dist/sub/z.js' },
    ];
    const out = filterExcludedFiles(files, ['dist/**']);
    expect(out).toEqual([{ filename: 'src/y.js' }]);
  });

  test('returns empty array for empty input', () => {
    expect(filterExcludedFiles([], ['*.lock'])).toEqual([]);
  });

  // W12-1b: a null/undefined element in the files array crashed with
  // TypeError. Every other function guards against null elements.
  test('W12-1b: does not crash on null/undefined array elements', () => {
    const files = [null, undefined, { filename: 'a.js' }];
    const out = filterExcludedFiles(files, []);
    expect(out).toEqual([{ filename: 'a.js' }]);
  });
});
