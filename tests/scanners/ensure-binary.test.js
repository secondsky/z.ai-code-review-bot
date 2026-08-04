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
} from '../../src/lib/scanners/ensure-binary.js';

// A 6-byte payload with a known SHA256 (computed via the same helper, so this
// is a self-consistency check rather than a hardcoded digest).
const SAMPLE_BYTES = Buffer.from('hello\n');
const SAMPLE_SHA = sha256Hex(SAMPLE_BYTES);

/** A minimal fake `deps` kit. Each method is wrapped to track invocations. */
function fakeDeps(overrides = {}) {
  const calls = { stat: 0, fetch: 0, writeFile: 0, chmod: 0 };
  const defaultStat = async () => { throw new Error('ENOENT'); };
  const defaultFetch = async () => SAMPLE_BYTES;
  const defaultWriteFile = async (path, bytes) => {
    calls.lastWrite = { path, bytes };
  };
  const defaultChmod = async (path, mode) => {
    calls.lastChmod = { path, mode };
  };
  return {
    calls,
    stat: async (path) => { calls.stat++; return overrides.stat ? overrides.stat(path) : defaultStat(); },
    fetch: async (url) => { calls.fetch++; return overrides.fetch ? overrides.fetch(url) : defaultFetch(); },
    writeFile: async (path, bytes) => {
      calls.writeFile++;
      return overrides.writeFile ? overrides.writeFile(path, bytes) : defaultWriteFile(path, bytes);
    },
    chmod: async (path, mode) => {
      calls.chmod++;
      return overrides.chmod ? overrides.chmod(path, mode) : defaultChmod(path, mode);
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
    });
    const path = await ensureBinary(baseSpec(), deps);
    expect(path.endsWith('/gitleaks/8.21.2/gitleaks')).toBe(true);
    expect(deps.calls.stat).toBe(1);
    expect(deps.calls.fetch).toBe(0);
    expect(deps.calls.writeFile).toBe(0);
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
