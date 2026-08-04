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
});
