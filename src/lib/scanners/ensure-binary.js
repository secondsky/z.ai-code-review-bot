/**
 * Shared fetch-cache-verify helper for runtime-downloaded scanner binaries
 * (gitleaks, ast-grep).
 *
 * Architecture — the injection seam:
 *   Every external collaborator is passed via `deps` so tests never touch the
 *   network or filesystem. Production wires real Node builtins (`https`,
 *   `fs/promises`, `crypto`) — see `createDefaultDeps()`. Tests inject fakes
 *   that return canned bytes / lie about `stat`.
 *
 * The flow is deliberately small:
 *   1. Resolve the cache path: `${cacheDir}/${name}/${version}/${name}${ext}`.
 *   2. Cache hit: `deps.stat(path)` resolves → return path (no fetch).
 *   3. Cache miss: `deps.fetch(url)` → bytes → SHA256-verify → `writeFile` →
 *      `chmod 0o755` → return path.
 *
 * Extraction (gitleaks ships as .tar.gz; ast-grep is a raw binary on Linux/
 * macOS and a .zip on Windows) is delegated to the caller via the
 * `extractor` hook on the spec. When `spec.extractor` is set, the bytes are
 * written to a temp tarball/zip, `extractor(tempPath, destPath, deps)` is
 * invoked, and the temp file is deleted. The default `extractor` simply moves
 * the bytes into place (the no-extraction case for raw binaries).
 *
 * @module src/lib/scanners/ensure-binary.js
 */

import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Compute the SHA-256 hex digest of a Buffer/string using Node's crypto.
 *
 * @param {Buffer | string} bytes
 * @returns {string} lowercase hex digest
 */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Resolve the cache path for a binary. Pure (no I/O).
 *
 *   `${cacheDir}/${name}/${version}/${name}${ext}`
 *
 * @param {{ cacheDir: string, name: string, version: string, ext?: string }} spec
 * @returns {string}
 */
export function resolveCachePath(spec) {
  const cacheDir = spec?.cacheDir;
  const name = spec?.name;
  const version = spec?.version;
  const ext = typeof spec?.ext === 'string' ? spec.ext : '';
  if (typeof cacheDir !== 'string' || !cacheDir) {
    throw new Error('ensureBinary: cacheDir is required');
  }
  if (typeof name !== 'string' || !name) {
    throw new Error('ensureBinary: name is required');
  }
  if (typeof version !== 'string' || !version) {
    throw new Error('ensureBinary: version is required');
  }
  return join(cacheDir, name, version, `${name}${ext}`);
}

/**
 * Default `extractor` for raw binaries: writes the bytes to `destPath` and
 * returns `destPath`. Used when no tarball/zip extraction is needed.
 *
 * @param {Buffer} bytes
 * @param {string} destPath
 * @param {{ writeFile: (path: string, bytes: Buffer) => Promise<void>, chmod?: (path: string, mode: number) => Promise<void> }} deps
 * @returns {Promise<string>}
 */
async function defaultExtractor(bytes, destPath, deps) {
  await deps.writeFile(destPath, bytes);
  if (typeof deps.chmod === 'function') {
    await deps.chmod(destPath, 0o755);
  }
  return destPath;
}

/**
 * Ensure a binary is available in the cache dir, fetching + verifying if not.
 *
 * All I/O is injected via `deps` so this is fully testable without network.
 *
 * @param {{
 *   name: string,
 *   version: string,
 *   url: string,
 *   checksumSha256: string,
 *   cacheDir: string,
 *   ext?: string,
 *   extractor?: (bytes: Buffer, destPath: string, deps: Object) => Promise<string>,
 * }} opts
 * @param {{
 *   fetch?: (url: string) => Promise<Buffer>,
 *   writeFile?: (path: string, bytes: Buffer) => Promise<void>,
 *   chmod?: (path: string, mode: number) => Promise<void>,
 *   stat?: (path: string) => Promise<{ size: number }>,
 *   platform?: string,
 *   arch?: string,
 * }} [deps]
 * @returns {Promise<string>} the absolute path to the verified binary
 * @throws {Error} on checksum mismatch (`${name}: checksum mismatch`) or fetch failure.
 */
export async function ensureBinary(opts, deps = {}) {
  const spec = opts || {};
  const name = spec.name;
  const version = spec.version;
  const expectedChecksum = spec.checksumSha256;
  const url = spec.url;

  if (typeof name !== 'string' || !name) {
    throw new Error('ensureBinary: name is required');
  }
  if (typeof version !== 'string' || !version) {
    throw new Error('ensureBinary: version is required');
  }
  if (typeof url !== 'string' || !url) {
    throw new Error('ensureBinary: url is required');
  }
  if (typeof expectedChecksum !== 'string' || expectedChecksum.length !== 64) {
    throw new Error(`ensureBinary: ${name}: checksumSha256 must be a 64-char hex string`);
  }

  const cachePath = resolveCachePath(spec);
  const stat = deps.stat;
  if (typeof stat === 'function') {
    try {
      await stat(cachePath);
      // Cache hit — file exists. No fetch, no verify.
      return cachePath;
    } catch {
      // File doesn't exist → fall through to fetch.
    }
  }

  if (typeof deps.fetch !== 'function') {
    throw new Error(`ensureBinary: ${name}: fetch is required (no cache hit)`);
  }

  let bytes;
  try {
    bytes = await deps.fetch(url);
  } catch (err) {
    throw new Error(`ensureBinary: ${name}: fetch failed: ${err?.message ?? String(err)}`);
  }

  if (!Buffer.isBuffer(bytes)) {
    // Accept string responses by coercing to Buffer (defensive).
    bytes = Buffer.from(/** @type {any} */ (bytes));
  }

  const actual = sha256Hex(bytes);
  if (actual.toLowerCase() !== expectedChecksum.toLowerCase()) {
    throw new Error(
      `ensureBinary: ${name}: checksum mismatch (expected ${expectedChecksum}, got ${actual})`,
    );
  }

  const extractor =
    typeof spec.extractor === 'function' ? spec.extractor : defaultExtractor;

  if (typeof deps.writeFile !== 'function') {
    throw new Error(`ensureBinary: ${name}: writeFile is required`);
  }

  // For raw binaries we go straight to writeFile via the default extractor.
  // For tarball/zip archives, the caller-provided extractor handles extraction
  // to destPath and is responsible for chmod-ing the resulting binary.
  await extractor(bytes, cachePath, deps);
  return cachePath;
}

/**
 * Pick the right release URL + checksum for the current `platform_arch` tuple
 * from a `urls` / `checksums` map (keyed like `darwin_arm64`).
 *
 * Returns `{ url, checksumSha256 }` or `null` if the tuple is unsupported.
 *
 * @param {{
 *   urls: Record<string, string>,
 *   checksums: Record<string, string>,
 * }} spec
 * @param {{ platform?: string, arch?: string }} [deps]
 * @returns {{ url: string, checksumSha256: string } | null}
 */
export function selectPlatformAsset(spec, deps = {}) {
  const platform = deps.platform || '';
  const arch = deps.arch || '';
  const key = `${platform}_${arch}`;
  const url = spec?.urls?.[key];
  const checksumSha256 = spec?.checksums?.[key];
  if (typeof url !== 'string' || !url) return null;
  if (typeof checksumSha256 !== 'string' || checksumSha256.length !== 64) return null;
  return { url, checksumSha256 };
}

/**
 * Build a unique temp path inside the OS tmpdir for a given archive name.
 * Used by tarball extractors. Pure (no I/O).
 *
 * @param {string} archiveName
 * @returns {string}
 */
export function tempPathFor(archiveName) {
  // Suffix with pid + random to avoid collisions across concurrent calls.
  const nonce = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  return join(tmpdir(), `zaibot-${nonce}-${archiveName}`);
}
