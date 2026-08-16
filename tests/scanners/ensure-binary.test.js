/**
 * Tests for the binary fetch-cache-verify helper (src/lib/scanners/ensure-binary.js).
 *
 * Every test injects fake `deps` (stat / fetch / writeFile / chmod) — no real
 * network or filesystem is touched. The SHA256 helper is exercised against
 * real crypto (the bytes are deterministic).
 */
import { describe, it, expect } from 'vitest';
import {
  ensureBinary,
  sha256Hex,
  resolveCachePath,
  selectPlatformAsset,
  tempPathFor,
  tarGzExtractor,
  zipExtractor,
  pickExtractor,
} from '../../src/lib/scanners/ensure-binary.js';

// A 6-byte payload with a known SHA256 (computed via the same helper, so this
// is a self-consistency check rather than a hardcoded digest).
const SAMPLE_BYTES = Buffer.from('hello\n');
const SAMPLE_SHA = sha256Hex(SAMPLE_BYTES);

/** A minimal fake `deps` kit. Each method is wrapped to track invocations. */
function fakeDeps(overrides = {}) {
  const calls = { stat: 0, fetch: 0, writeFile: 0, chmod: 0, readFile: 0, rm: 0 };
  const defaultStat = async () => { throw new Error('ENOENT'); };
  const defaultFetch = async () => SAMPLE_BYTES;
  const defaultWriteFile = async (path, bytes) => {
    calls.lastWrite = { path, bytes };
  };
  const defaultChmod = async (path, mode) => {
    calls.lastChmod = { path, mode };
  };
  const defaultReadFile = async () => { throw new Error('ENOENT'); };
  const defaultRm = async () => {};
  return {
    calls,
    stat: async (path) => { calls.stat++; return overrides.stat ? overrides.stat(path) : defaultStat(); },
    fetch: async (url) => { calls.fetch++; return overrides.fetch ? overrides.fetch(url) : defaultFetch(url); },
    writeFile: async (path, bytes) => {
      calls.writeFile++;
      return overrides.writeFile ? overrides.writeFile(path, bytes) : defaultWriteFile(path, bytes);
    },
    chmod: async (path, mode) => {
      calls.chmod++;
      return overrides.chmod ? overrides.chmod(path, mode) : defaultChmod(path, mode);
    },
    readFile: async (path) => {
      calls.readFile++;
      return overrides.readFile ? overrides.readFile(path) : defaultReadFile(path);
    },
    rm: async (path) => {
      calls.rm++;
      calls.lastRm = { path };
      return overrides.rm ? overrides.rm(path) : defaultRm(path);
    },
    platform: overrides.platform ?? 'linux',
    arch: overrides.arch ?? 'x64',
  };
}

const baseSpec = (overrides = {}) => ({
  name: 'gitleaks',
  version: '8.21.2',
  url: 'https://example.com/gitleaks.tar.gz',
  checksumSha256: SAMPLE_SHA,
  cacheDir: '/cache',
  ...overrides,
});

describe('sha256Hex', () => {
  it('returns a 64-char lowercase hex digest', () => {
    const h = sha256Hex(Buffer.from('hello\n'));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for the same input', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe(sha256Hex(Buffer.from('abc')));
  });

  it('accepts string input', () => {
    expect(sha256Hex('hello\n')).toBe(SAMPLE_SHA);
  });

  it('returns the canonical SHA-256 for the empty string', () => {
    // well-known digest of ''
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('resolveCachePath', () => {
  it('builds cacheDir/name/version/name+ext', () => {
    const p = resolveCachePath({ cacheDir: '/c', name: 'gl', version: '1.2.3' });
    const expected = ['/c', 'gl', '1.2.3', 'gl'].join('/');
    expect(p).toBe(expected);
  });

  it('appends ext when provided', () => {
    const p = resolveCachePath({
      cacheDir: '/c',
      name: 'gl',
      version: '1.2.3',
      ext: '.exe',
    });
    expect(p.endsWith('/gl/1.2.3/gl.exe')).toBe(true);
  });

  it('throws when cacheDir missing', () => {
    expect(() => resolveCachePath({ name: 'a', version: '1' })).toThrow(/cacheDir/);
  });

  it('throws when name missing', () => {
    expect(() => resolveCachePath({ cacheDir: '/c', version: '1' })).toThrow(/name/);
  });

  it('throws when version missing', () => {
    expect(() => resolveCachePath({ cacheDir: '/c', name: 'a' })).toThrow(/version/);
  });

  it('rejects a name containing a forward slash (path traversal guard)', () => {
    expect(() =>
      resolveCachePath({ cacheDir: '/c', name: '../evil', version: '1.0' }),
    ).toThrow();
  });

  it('rejects a name containing a backslash (path traversal guard)', () => {
    expect(() =>
      resolveCachePath({ cacheDir: '/c', name: '..\\evil', version: '1.0' }),
    ).toThrow();
  });

  it('rejects a version containing a path separator (path traversal guard)', () => {
    expect(() =>
      resolveCachePath({ cacheDir: '/c', name: 'gl', version: '../../../etc/passwd' }),
    ).toThrow();
  });

  it('rejects a version containing a backslash (path traversal guard)', () => {
    expect(() =>
      resolveCachePath({ cacheDir: '/c', name: 'gl', version: '..\\..\\evil' }),
    ).toThrow();
  });
});

describe('selectPlatformAsset', () => {
  const spec = {
    urls: { darwin_arm64: 'u1', linux_x64: 'u2' },
    checksums: {
      darwin_arm64: 'a'.repeat(64),
      linux_x64: 'b'.repeat(64),
    },
  };

  it('selects the asset matching platform+arch', () => {
    const a = selectPlatformAsset(spec, { platform: 'darwin', arch: 'arm64' });
    expect(a).toEqual({ url: 'u1', checksumSha256: 'a'.repeat(64) });
  });

  it('returns null for an unsupported tuple', () => {
    expect(selectPlatformAsset(spec, { platform: 'win32', arch: 'x64' })).toBeNull();
  });

  it('returns null when checksum is missing even if url present', () => {
    const bad = { urls: { linux_x64: 'u' }, checksums: {} };
    expect(selectPlatformAsset(bad, { platform: 'linux', arch: 'x64' })).toBeNull();
  });
});

describe('tempPathFor', () => {
  it('returns a path containing the archive name', () => {
    const p = tempPathFor('gitleaks.tar.gz');
    expect(p).toContain('gitleaks.tar.gz');
    expect(p).toContain('zaibot-');
  });
});

describe('ensureBinary — cache hit', () => {
  it('returns the cache path without fetching when stat resolves', async () => {
    const deps = fakeDeps({
      stat: async () => ({ size: 1234 }), // exists
      readFile: async () => SAMPLE_BYTES, // hash matches
    });
    const path = await ensureBinary(baseSpec(), deps);
    expect(path.endsWith('/gitleaks/8.21.2/gitleaks')).toBe(true);
    expect(deps.calls.stat).toBe(1);
    expect(deps.calls.fetch).toBe(0);
    expect(deps.calls.writeFile).toBe(0);
  });

  // SCN-10: a cached file whose hash no longer matches expectedChecksum must be
  // invalidated (deleted) and re-downloaded.
  it('re-downloads when the cached file hash does not match expectedChecksum', async () => {
    const deps = fakeDeps({
      stat: async () => ({ size: 1234 }), // cache file exists
      readFile: async () => Buffer.from('tampered\n'), // wrong hash
    });
    const path = await ensureBinary(baseSpec(), deps);
    expect(path.endsWith('/gitleaks/8.21.2/gitleaks')).toBe(true);
    // Cache was invalidated: readFile ran, fetch re-ran, writeFile re-ran.
    expect(deps.calls.readFile).toBe(1);
    expect(deps.calls.rm).toBe(1); // stale cached file deleted
    expect(deps.calls.fetch).toBe(1);
    expect(deps.calls.writeFile).toBe(1);
  });
});

describe('ensureBinary — cache miss, happy path', () => {
  it('fetches, verifies, writes, and chmods', async () => {
    const deps = fakeDeps();
    const path = await ensureBinary(baseSpec(), deps);
    expect(path.endsWith('/gitleaks/8.21.2/gitleaks')).toBe(true);
    expect(deps.calls.stat).toBe(1);
    expect(deps.calls.fetch).toBe(1);
    expect(deps.calls.writeFile).toBe(1);
    expect(deps.calls.chmod).toBe(1);
    expect(deps.calls.lastChmod.mode).toBe(0o755);
    expect(deps.calls.lastWrite.bytes).toEqual(SAMPLE_BYTES);
  });

  it('coerces a string fetch response to Buffer', async () => {
    const deps = fakeDeps({
      fetch: async () => 'hello\n', // string, not Buffer
    });
    const path = await ensureBinary(baseSpec(), deps);
    expect(path).toBeTruthy();
    expect(deps.calls.writeFile).toBe(1);
  });
});

describe('ensureBinary — checksum mismatch', () => {
  it('throws "checksum mismatch" and does NOT write', async () => {
    const deps = fakeDeps();
    await expect(
      ensureBinary(
        baseSpec({ checksumSha256: '0'.repeat(64) }),
        deps,
      ),
    ).rejects.toThrow(/checksum mismatch/);
    expect(deps.calls.fetch).toBe(1);
    expect(deps.calls.writeFile).toBe(0);
  });

  it('compares checksums case-insensitively', async () => {
    const deps = fakeDeps();
    const upper = SAMPLE_SHA.toUpperCase();
    const path = await ensureBinary(baseSpec({ checksumSha256: upper }), deps);
    expect(path).toBeTruthy();
  });
});

describe('ensureBinary — fetch failure', () => {
  it('rethrows with fetch-failed wrapping', async () => {
    const deps = fakeDeps({
      fetch: async () => {
        throw new Error('HTTP 503');
      },
    });
    await expect(ensureBinary(baseSpec(), deps)).rejects.toThrow(/fetch failed/);
    expect(deps.calls.writeFile).toBe(0);
  });
});

describe('ensureBinary — validation', () => {
  it('rejects a missing name', async () => {
    await expect(ensureBinary(baseSpec({ name: '' }), fakeDeps())).rejects.toThrow(/name/);
  });

  it('rejects a missing url', async () => {
    await expect(ensureBinary(baseSpec({ url: '' }), fakeDeps())).rejects.toThrow(/url/);
  });

  it('rejects a too-short checksum', async () => {
    await expect(
      ensureBinary(baseSpec({ checksumSha256: 'short' }), fakeDeps()),
    ).rejects.toThrow(/checksumSha256/);
  });

  it('rejects when fetch is not provided on cache miss', async () => {
    const deps = fakeDeps();
    delete deps.fetch;
    await expect(ensureBinary(baseSpec(), deps)).rejects.toThrow(/fetch is required/);
  });

  it('rejects when writeFile is not provided on cache miss', async () => {
    const deps = fakeDeps();
    delete deps.writeFile;
    await expect(ensureBinary(baseSpec(), deps)).rejects.toThrow(/writeFile is required/);
  });
});

describe('ensureBinary — custom extractor', () => {
  it('uses spec.extractor when provided and forwards deps', async () => {
    const extractorCalls = [];
    const extractor = async (bytes, destPath, d) => {
      extractorCalls.push({ bytesLen: bytes.length, destPath });
      await d.writeFile(destPath, bytes);
      await d.chmod(destPath, 0o755);
      return destPath;
    };
    const deps = fakeDeps();
    await ensureBinary(baseSpec({ extractor }), deps);
    expect(extractorCalls).toHaveLength(1);
    expect(extractorCalls[0].destPath.endsWith('/gitleaks/8.21.2/gitleaks')).toBe(true);
    expect(deps.calls.writeFile).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * pickExtractor — URL-extension dispatch
 * ------------------------------------------------------------------ */

describe('pickExtractor', () => {
  it('returns zipExtractor for .zip URLs', () => {
    expect(pickExtractor('https://example.com/asset.zip')).toBe(zipExtractor);
  });

  it('returns tarGzExtractor for .tar.gz URLs', () => {
    expect(pickExtractor('https://example.com/asset.tar.gz')).toBe(tarGzExtractor);
  });

  it('returns tarGzExtractor for .tgz URLs', () => {
    expect(pickExtractor('https://example.com/asset.tgz')).toBe(tarGzExtractor);
  });

  it('returns null for raw-binary URLs (no archive extension)', () => {
    expect(pickExtractor('https://example.com/astgrep-binary')).toBeNull();
  });

  it('is case-insensitive on the extension', () => {
    expect(pickExtractor('https://example.com/ASSET.ZIP')).toBe(zipExtractor);
  });

  it('returns null for empty / non-string input', () => {
    expect(pickExtractor('')).toBeNull();
    expect(pickExtractor(/** @type {any} */ (undefined))).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * tarGzExtractor — system-tar flow
 * ------------------------------------------------------------------ */

/**
 * Build a fake-deps kit suitable for the archive extractors: tracks every
 * `runCommand` / `mkdir` / `readdir` / `rename` / `chmod` / `rm` / `writeFile`
 * call, and simulates an extraction by "producing" the named entries in the
 * extract dir for `readdir`.
 *
 * @param {Object} [opts]
 * @param {string[]} [opts.entries] - filenames the fake `readdir` returns
 * @param {string} [opts.platform]
 * @param {Error|null} [opts.tarError] - if set, the first tar call rejects
 * @param {Error|null} [opts.psError] - if set, the powershell fallback rejects
 * @param {Record<string, Error>} [opts.commandErrors] - per-command rejection
 *   map (e.g. `{ unzip: new Error('no unzip') }`), checked on every call
 * @returns {Object}
 */
function fakeArchiveDeps(opts = {}) {
  const calls = {
    runCommand: [],
    writeFile: [],
    mkdir: [],
    readdir: [],
    rename: [],
    chmod: [],
    rm: [],
  };
  const entries = Array.isArray(opts.entries) ? opts.entries : ['gitleaks'];
  let tarCallCount = 0;
  let psCallCount = 0;
  return {
    calls,
    platform: opts.platform ?? 'linux',
    runCommand: async (cmd, args) => {
      calls.runCommand.push({ cmd, args });
      if (cmd === 'tar') {
        tarCallCount++;
        if (opts.tarError && tarCallCount === 1) throw opts.tarError;
      }
      if (cmd === 'powershell.exe' || cmd === 'pwsh') {
        psCallCount++;
        if (opts.psError) throw opts.psError;
      }
      if (opts.commandErrors && opts.commandErrors[cmd]) {
        throw opts.commandErrors[cmd];
      }
      return { stdout: '', stderr: '' };
    },
    writeFile: async (p, b) => {
      calls.writeFile.push({ path: p, bytesLen: Buffer.isBuffer(b) ? b.length : b.length });
    },
    mkdir: async (p) => {
      calls.mkdir.push({ path: p });
    },
    readdir: async (p) => {
      calls.readdir.push({ path: p });
      return entries.slice();
    },
    rename: async (a, b) => {
      calls.rename.push({ from: a, to: b });
    },
    chmod: async (p, m) => {
      calls.chmod.push({ path: p, mode: m });
    },
    rm: async (p) => {
      calls.rm.push({ path: p });
    },
  };
}

describe('tarGzExtractor', () => {
  it('writes bytes to a temp archive, extracts via tar -xzf, moves + chmods', async () => {
    const deps = fakeArchiveDeps({ entries: ['gitleaks'] });
    const bytes = Buffer.from('fake-tar-bytes');
    const destPath = '/cache/gitleaks/8.21.2/gitleaks';

    const out = await tarGzExtractor(bytes, destPath, deps);

    expect(out).toBe(destPath);

    // 1. Wrote the archive to a temp path.
    expect(deps.calls.writeFile).toHaveLength(1);
    expect(deps.calls.writeFile[0].path).toMatch(/archive\.tar\.gz$/);

    // 2. Created an extraction dir, then ensured destPath's parent exists.
    expect(deps.calls.mkdir).toHaveLength(2);
    expect(deps.calls.mkdir[0].path).toMatch(/\.d$/);
    expect(deps.calls.mkdir[1].path).toBe('/cache/gitleaks/8.21.2');

    // 3. Invoked tar with -xzf and -C.
    expect(deps.calls.runCommand).toHaveLength(1);
    const { cmd, args } = deps.calls.runCommand[0];
    expect(cmd).toBe('tar');
    expect(args[0]).toBe('-xzf');
    expect(args).toContain('-C');
    // The archive path passed to tar must match what was written.
    expect(args[1]).toBe(deps.calls.writeFile[0].path);
    expect(args[args.indexOf('-C') + 1]).toBe(deps.calls.mkdir[0].path);

    // 4. Picked the binary from the extract dir (basename match) + moved it.
    expect(deps.calls.rename).toHaveLength(1);
    expect(deps.calls.rename[0].to).toBe(destPath);

    // 5. Chmodded destPath 0o755 (Windows bsdtar doesn't preserve exec bit).
    expect(deps.calls.chmod).toHaveLength(1);
    expect(deps.calls.chmod[0]).toEqual({ path: destPath, mode: 0o755 });

    // 6. Best-effort cleanup of the extract dir.
    expect(deps.calls.rm).toHaveLength(1);
    expect(deps.calls.rm[0].path).toBe(deps.calls.mkdir[0].path);
  });

  it('uses GNU/bsdtar-compatible flags only (no --no-same-owner)', async () => {
    const deps = fakeArchiveDeps({ entries: ['gitleaks'] });
    await tarGzExtractor(Buffer.from('x'), '/d/gitleaks', deps);
    const args = deps.calls.runCommand[0].args;
    for (const a of args) {
      // Reject any GNU-only flag we know bsdtar rejects.
      expect(a).not.toMatch(/^--no-same-owner/);
      expect(a).not.toMatch(/^--hard-dereference/);
      expect(a).not.toMatch(/^--force-local/);
    }
  });

  it('throws a wrapped error when tar fails and cleans up', async () => {
    const deps = fakeArchiveDeps({
      entries: ['gitleaks'],
      tarError: new Error('tar: invalid magic'),
    });
    await expect(
      tarGzExtractor(Buffer.from('bad'), '/d/gitleaks', deps),
    ).rejects.toThrow(/tarGzExtractor: tar failed/);
    // Should NOT have chmodded or renamed anything.
    expect(deps.calls.rename).toHaveLength(0);
    expect(deps.calls.chmod).toHaveLength(0);
  });

  it('prefers an exact-name match when archive contains multiple files', async () => {
    // gitleaks tarballs contain LICENSE, README.md, gitleaks — we want gitleaks.
    const deps = fakeArchiveDeps({ entries: ['LICENSE', 'README.md', 'gitleaks'] });
    const destPath = '/cache/gitleaks/8.21.2/gitleaks';
    await tarGzExtractor(Buffer.from('x'), destPath, deps);
    expect(deps.calls.rename[0].from).toMatch(/gitleaks$/);
    expect(deps.calls.rename[0].from).not.toMatch(/LICENSE|README/);
  });

  it('coerces a string bytes argument to Buffer', async () => {
    const deps = fakeArchiveDeps({ entries: ['gitleaks'] });
    // Pass a string — should not throw.
    await tarGzExtractor('string-bytes', '/d/gitleaks', deps);
    expect(deps.calls.runCommand).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * zipExtractor — system-tar flow + Windows Expand-Archive fallback
 * ------------------------------------------------------------------ */

describe('zipExtractor', () => {
  it('extracts via tar -xf on non-Windows (single binary inside)', async () => {
    const deps = fakeArchiveDeps({ entries: ['ast-grep'], platform: 'linux' });
    const bytes = Buffer.from('fake-zip-bytes');
    const destPath = '/cache/ast-grep/0.34.3/ast-grep';

    const out = await zipExtractor(bytes, destPath, deps);

    expect(out).toBe(destPath);

    // 1. Wrote the archive to a temp .zip.
    expect(deps.calls.writeFile).toHaveLength(1);
    expect(deps.calls.writeFile[0].path).toMatch(/archive\.zip$/);

    // 2. tar -xf (NOT -xzf — it's a zip, not gzipped).
    expect(deps.calls.runCommand).toHaveLength(1);
    const { cmd, args } = deps.calls.runCommand[0];
    expect(cmd).toBe('tar');
    expect(args[0]).toBe('-xf');

    // 3. Moved + chmodded.
    expect(deps.calls.rename[0].to).toBe(destPath);
    expect(deps.calls.chmod[0]).toEqual({ path: destPath, mode: 0o755 });
  });

  it('picks ast-grep out of an archive that also contains sg (real ast-grep shape)', async () => {
    // ast-grep 0.34.3 zips contain BOTH `sg` (CLI alias) and `ast-grep`.
    const deps = fakeArchiveDeps({ entries: ['sg', 'ast-grep'], platform: 'darwin' });
    const destPath = '/cache/ast-grep/0.34.3/ast-grep';
    await zipExtractor(Buffer.from('x'), destPath, deps);
    expect(deps.calls.rename[0].from).toMatch(/ast-grep$/);
    expect(deps.calls.rename[0].from).not.toMatch(/\/sg$/);
  });

  it('falls back to powershell.exe Expand-Archive on Windows when tar fails', async () => {
    const deps = fakeArchiveDeps({
      entries: ['gitleaks.exe'],
      platform: 'win32',
      tarError: new Error('tar: zip not supported'),
    });
    const destPath = '/cache/gitleaks/8.21.2/gitleaks';
    // Note: destPath basename is "gitleaks"; the archive contains
    // "gitleaks.exe" — the picker falls through to the .exe variant.
    await zipExtractor(Buffer.from('x'), destPath, deps);

    // Both calls happened: tar (failed) then powershell.exe (succeeded).
    expect(deps.calls.runCommand).toHaveLength(2);
    expect(deps.calls.runCommand[0].cmd).toBe('tar');
    expect(deps.calls.runCommand[1].cmd).toBe('powershell.exe');
    const psArgs = deps.calls.runCommand[1].args;
    expect(psArgs).toContain('-NoProfile');
    expect(psArgs).toContain('-Command');
    // The Expand-Archive command references both paths.
    const psCmd = psArgs[psArgs.indexOf('-Command') + 1];
    expect(psCmd).toMatch(/Expand-Archive/);
    expect(psCmd).toMatch(/-Force/);

    // The .exe variant was picked and moved into place.
    expect(deps.calls.rename[0].from).toMatch(/gitleaks\.exe$/);
    expect(deps.calls.rename[0].to).toBe(destPath);
  });

  it('throws a combined error when both tar and Expand-Archive fail on Windows', async () => {
    const deps = fakeArchiveDeps({
      entries: ['gitleaks.exe'],
      platform: 'win32',
      tarError: new Error('tar: boom'),
      psError: new Error('Expand-Archive: bad zip'),
    });
    await expect(
      zipExtractor(Buffer.from('x'), '/d/gitleaks', deps),
    ).rejects.toThrow(/all extraction attempts failed/);
    expect(deps.calls.rename).toHaveLength(0);
  });

  it('falls back to unzip when tar fails on non-Windows (GNU tar cannot read zip) [W15-A5-4]', async () => {
    // ubuntu-latest ships GNU tar, which rejects zip archives — the old code
    // had NO non-Windows fallback and ast-grep extraction always failed.
    const deps = fakeArchiveDeps({
      entries: ['ast-grep'],
      platform: 'linux',
      tarError: new Error('tar: This does not look like a tar archive'),
    });
    const destPath = '/cache/ast-grep/0.34.3/ast-grep';
    const out = await zipExtractor(Buffer.from('x'), destPath, deps);

    // Extraction succeeded via the unzip fallback and finalized normally.
    expect(out).toBe(destPath);
    expect(deps.calls.runCommand).toHaveLength(2);
    expect(deps.calls.runCommand[0].cmd).toBe('tar');
    expect(deps.calls.runCommand[1].cmd).toBe('unzip');
    expect(deps.calls.runCommand[1].args[0]).toBe('-o');
    expect(deps.calls.runCommand[1].args).toContain('-d');
    // The archive + dir passed to unzip are the ones we wrote/created.
    expect(deps.calls.runCommand[1].args[1]).toBe(deps.calls.writeFile[0].path);
    expect(deps.calls.runCommand[1].args[3]).toBe(deps.calls.mkdir[0].path);
    expect(deps.calls.rename[0].to).toBe(destPath);
    expect(deps.calls.chmod[0]).toEqual({ path: destPath, mode: 0o755 });
  });

  it('falls back to python3 -m zipfile when both tar and unzip fail [W15-A5-4]', async () => {
    const deps = fakeArchiveDeps({
      entries: ['ast-grep'],
      platform: 'linux',
      commandErrors: {
        tar: new Error('tar: not a tar archive'),
        unzip: new Error('unzip: cannot find zipfile'),
      },
    });
    const destPath = '/cache/ast-grep/0.34.3/ast-grep';
    const out = await zipExtractor(Buffer.from('x'), destPath, deps);

    expect(out).toBe(destPath);
    const cmds = deps.calls.runCommand.map((c) => c.cmd);
    expect(cmds).toEqual(['tar', 'unzip', 'python3']);
    const pyArgs = deps.calls.runCommand[2].args;
    expect(pyArgs).toEqual([
      '-m', 'zipfile', '-e',
      deps.calls.writeFile[0].path,
      `${deps.calls.mkdir[0].path}/`,
    ]);
    expect(deps.calls.rename[0].to).toBe(destPath);
  });

  it('throws an error listing every failed attempt when tar, unzip AND python3 all fail [W15-A5-4]', async () => {
    const deps = fakeArchiveDeps({
      entries: ['ast-grep'],
      platform: 'linux',
      commandErrors: {
        tar: new Error('tar: boom'),
        unzip: new Error('unzip: boom'),
        python3: new Error('python3: boom'),
      },
    });
    await expect(
      zipExtractor(Buffer.from('x'), '/d/ast-grep', deps),
    ).rejects.toThrow(/all extraction attempts failed/);
    // The message lists each attempted extractor.
    await expect(
      zipExtractor(Buffer.from('x'), '/d/ast-grep', deps),
    ).rejects.toThrow(/tar:.*unzip:.*python3:/s);
    expect(deps.calls.rename).toHaveLength(0);
    expect(deps.calls.chmod).toHaveLength(0);
  });

  it('still uses ONLY tar (no unzip/python3) when tar succeeds on non-Windows', async () => {
    const deps = fakeArchiveDeps({ entries: ['ast-grep'], platform: 'linux' });
    await zipExtractor(Buffer.from('x'), '/d/ast-grep', deps);
    expect(deps.calls.runCommand).toHaveLength(1);
    expect(deps.calls.runCommand[0].cmd).toBe('tar');
  });

  it('uses -xf (NOT -xzf) — zips are not gzip-compressed', async () => {
    const deps = fakeArchiveDeps({ entries: ['ast-grep'], platform: 'darwin' });
    await zipExtractor(Buffer.from('x'), '/d/ast-grep', deps);
    expect(deps.calls.runCommand[0].args[0]).toBe('-xf');
  });

  it('throws when the archive contains no files', async () => {
    const deps = fakeArchiveDeps({ entries: [], platform: 'linux' });
    await expect(
      zipExtractor(Buffer.from('x'), '/d/ast-grep', deps),
    ).rejects.toThrow(/archive contained no files/);
  });
});

/* ------------------------------------------------------------------ *
 * End-to-end: ensureBinary + custom extractor (the spec wiring)
 * ------------------------------------------------------------------ */

describe('ensureBinary — integration with tarGzExtractor', () => {
  it('invokes spec.extractor in place of defaultExtractor and returns the cache path', async () => {
    const extractorCalls = [];
    const fakeExtractor = async (bytes, destPath, d) => {
      extractorCalls.push({ bytesLen: bytes.length, destPath });
      // Mimic what tarGzExtractor would do at the contract level.
      if (typeof d.chmod === 'function') await d.chmod(destPath, 0o755);
      return destPath;
    };
    const deps = fakeDeps();
    const path = await ensureBinary(baseSpec({ extractor: fakeExtractor }), deps);
    expect(path.endsWith('/gitleaks/8.21.2/gitleaks')).toBe(true);
    expect(extractorCalls).toHaveLength(1);
    expect(deps.calls.chmod).toBe(1);
  });
});
