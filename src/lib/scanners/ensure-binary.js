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
import { dirname, basename, join } from 'node:path';
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import * as fs from 'node:fs/promises';

const execFile = promisify(execFileCb);

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
  // Defense-in-depth: reject path separators / traversal sequences in name,
  // version, and ext. These are currently hardcoded, but guard against future
  // regressions and untrusted inputs that could escape the cache dir.
  // W13-3: ext was previously unsanitized — ext='/../../../etc/shadow' would
  // escape the cache dir via join().
  for (const label of /** @type {const} */ (['name', 'version', 'ext'])) {
    const value = label === 'name' ? name : label === 'version' ? version : ext;
    if (/[\\/]/.test(value) || value === '..' || value.includes('..')) {
      throw new Error(
        `ensureBinary: ${label} must not contain path separators or ".." (got "${value}")`,
      );
    }
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
 * Pick the system `runCommand` dep, defaulting to promisify(execFile) from
 * node:child_process. Exposed for reuse by both archive extractors.
 *
 * @param {{ runCommand?: Function }} [deps]
 * @returns {Function}
 */
function resolveRunCommand(deps = {}) {
  return typeof deps.runCommand === 'function' ? deps.runCommand : execFile;
}

/**
 * Pick the system `mkdir` dep, defaulting to `fs/promises.mkdir` with recursive.
 *
 * @param {{ mkdir?: Function }} [deps]
 * @returns {Function}
 */
function resolveMkdir(deps = {}) {
  return typeof deps.mkdir === 'function'
    ? deps.mkdir
    : (p) => fs.mkdir(p, { recursive: true });
}

/**
 * Pick the system `writeFile` dep, defaulting to `fs/promises.writeFile`.
 *
 * @param {{ writeFile?: Function }} [deps]
 * @returns {Function}
 */
function resolveWriteFile(deps = {}) {
  return typeof deps.writeFile === 'function' ? deps.writeFile : (p, b) => fs.writeFile(p, b);
}

/**
 * Pick the system `chmod` dep, defaulting to `fs/promises.chmod`.
 *
 * @param {{ chmod?: Function }} [deps]
 * @returns {Function}
 */
function resolveChmod(deps = {}) {
  return typeof deps.chmod === 'function' ? deps.chmod : (p, m) => fs.chmod(p, m);
}

/**
 * Pick the system `readdir` dep, defaulting to `fs/promises.readdir`.
 *
 * @param {{ readdir?: Function }} [deps]
 * @returns {Function}
 */
function resolveReaddir(deps = {}) {
  return typeof deps.readdir === 'function' ? deps.readdir : (p) => fs.readdir(p);
}

/**
 * Pick the system `readFile` dep, defaulting to `fs/promises.readFile`.
 *
 * @param {{ readFile?: Function }} [deps]
 * @returns {Function}
 */
function resolveReadFile(deps = {}) {
  return typeof deps.readFile === 'function'
    ? deps.readFile
    : (p) => fs.readFile(p);
}

/**
 * Pick the system `rename` dep, defaulting to `fs/promises.rename`.
 *
 * @param {{ rename?: Function }} [deps]
 * @returns {Function}
 */
function resolveRename(deps = {}) {
  return typeof deps.rename === 'function' ? deps.rename : (a, b) => fs.rename(a, b);
}

/**
 * Pick the system `rm` dep, defaulting to `fs/promises.rm` (recursive).
 *
 * @param {{ rm?: Function }} [deps]
 * @returns {Function}
 */
function resolveRm(deps = {}) {
  return typeof deps.rm === 'function' ? deps.rm : (p) => fs.rm(p, { recursive: true, force: true });
}

/**
 * Resolve which extracted file should be moved to `destPath`. Strategy:
 *   1. Exact basename match (e.g. destPath `/x/ast-grep` → look for `ast-grep`).
 *   2. `.exe` variant on Windows (e.g. `gitleaks.exe`).
 *   3. Single file in the dir.
 *   4. First file in sorted order (last-resort deterministic).
 *
 * Returns the absolute path of the chosen file, or `null` if the dir is empty.
 *
 * @param {string[]} entries - filenames in the extraction dir
 * @param {string} dir - absolute path to the extraction dir
 * @param {string} destPath - the final desired cache path (basename = desired name)
 * @returns {string | null}
 */
function pickExtractedBinary(entries, dir, destPath) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const wanted = basename(destPath);
  // 1. Exact name match.
  const exact = entries.find((e) => e === wanted);
  if (exact) return join(dir, exact);
  // 2. `name.exe` (Windows).
  const exe = entries.find((e) => e === `${wanted}.exe`);
  if (exe) return join(dir, exe);
  // 3. Single file.
  if (entries.length === 1) return join(dir, entries[0]);
  // 4. Deterministic fallback: first when sorted, ignoring LICENSE/README.
  const filtered = entries
    .filter((e) => !/^(LICENSE|README|CHANGELOG|NOTICE)/i.test(e))
    .sort();
  if (filtered.length > 0) return join(dir, filtered[0]);
  return join(dir, entries.sort()[0]);
}

/**
 * Common post-extraction step: locate the binary inside `extractDir`, move it
 * to `destPath`, chmod 0o755 (Windows bsdtar doesn't preserve the exec bit on
 * zip members), and best-effort clean up the extraction dir. Returns destPath.
 *
 * @param {string} extractDir
 * @param {string} destPath
 * @param {Object} deps
 * @returns {Promise<string>}
 */
async function finalizeExtraction(extractDir, destPath, deps) {
  const readdir = resolveReaddir(deps);
  const rename = resolveRename(deps);
  const chmod = resolveChmod(deps);
  const rm = resolveRm(deps);

  let entries;
  try {
    entries = await readdir(extractDir);
  } catch (err) {
    throw new Error(`extractor: readdir(${extractDir}) failed: ${err?.message ?? String(err)}`);
  }

  const src = pickExtractedBinary(entries, extractDir, destPath);
  if (!src) {
    throw new Error(`extractor: archive contained no files (${extractDir})`);
  }

  // Move into place. rename is atomic on same-device; ensure parent dir exists.
  const parent = dirname(destPath);
  const mkdir = resolveMkdir(deps);
  await mkdir(parent);
  try {
    await rename(src, destPath);
  } catch {
    // Cross-device or dest exists — fall back to copy+delete via fs fallback.
    // We don't depend on deps.copyFile here for testability; tests that
    // exercise the happy path use rename-able fakes. Production fs.rename
    // works because everything is under the cache dir.
    await fs.copyFile(src, destPath);
    await fs.unlink(src).catch(() => {});
  }

  // Always chmod — Windows bsdtar doesn't preserve exec bit on zip members,
  // and tar.gz members may have wrong perms if built on a different umask.
  await chmod(destPath, 0o755);

  // Best-effort cleanup of the temp extraction dir (ignore errors).
  try {
    await rm(extractDir);
  } catch {
    /* best-effort */
  }
  return destPath;
}

/**
 * Extract a `.tar.gz` (also works for plain `.tar`) archive to destPath.
 *
 * Writes `bytes` to a temp archive, shells out to system `tar` (available on
 * every GitHub-hosted runner: macOS bsdtar, Linux GNU tar, Windows bsdtar in
 * System32), then moves the resolved binary into place and chmods it.
 *
 * Uses ONLY `tar` flags that work on BOTH GNU tar and bsdtar:
 *   - `-xzf <archive>` extract gzip-compressed
 *   - `-C <dir>` extract into dir
 * Do NOT use GNU-only flags like `--no-same-owner` (bsdtar rejects them).
 *
 * @param {Buffer} bytes
 * @param {string} destPath
 * @param {{ runCommand?: Function, mkdir?: Function, writeFile?: Function, readdir?: Function, rename?: Function, chmod?: Function, rm?: Function }} [deps]
 * @returns {Promise<string>}
 */
export async function tarGzExtractor(bytes, destPath, deps = {}) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  const runCommand = resolveRunCommand(deps);
  const writeFile = resolveWriteFile(deps);
  const mkdir = resolveMkdir(deps);

  const tmpArchive = tempPathFor('archive.tar.gz');
  const extractDir = `${tmpArchive}.d`;

  await writeFile(tmpArchive, bytes);
  await mkdir(extractDir);
  try {
    await runCommand('tar', ['-xzf', tmpArchive, '-C', extractDir]);
  } catch (err) {
    // Best-effort cleanup before rethrowing.
    await fs.unlink(tmpArchive).catch(() => {});
    await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`tarGzExtractor: tar failed: ${err?.message ?? String(err)}`);
  }

  // Best-effort cleanup of the temp archive (don't fail on cleanup error).
  try {
    await fs.unlink(tmpArchive);
  } catch {
    /* best-effort */
  }

  return finalizeExtraction(extractDir, destPath, deps);
}

/**
 * Extract a `.zip` archive to destPath.
 *
 * Writes `bytes` to a temp archive, then tries extractors in order until one
 * succeeds:
 *   - non-Windows: `tar -xf` (bsdtar reads zip on macOS; GNU tar — the default
 *     on ubuntu-latest — CANNOT), then `unzip -o`, then `python3 -m zipfile`
 *     (both are present on GitHub-hosted runners). [W15-A5-4]
 *   - Windows: `tar -xf` (System32 bsdtar), then `powershell Expand-Archive`.
 *
 * Throws a single error listing every failed attempt only when ALL extractors
 * fail.
 *
 * @param {Buffer} bytes
 * @param {string} destPath
 * @param {{ runCommand?: Function, mkdir?: Function, writeFile?: Function, readdir?: Function, rename?: Function, chmod?: Function, rm?: Function, platform?: string }} [deps]
 * @returns {Promise<string>}
 */
export async function zipExtractor(bytes, destPath, deps = {}) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  const runCommand = resolveRunCommand(deps);
  const writeFile = resolveWriteFile(deps);
  const mkdir = resolveMkdir(deps);
  const platform = typeof deps.platform === 'string' ? deps.platform : process.platform;

  const tmpArchive = tempPathFor('archive.zip');
  const extractDir = `${tmpArchive}.d`;

  await writeFile(tmpArchive, bytes);
  await mkdir(extractDir);

  // W15-A5-4: GNU tar (the default `tar` on ubuntu-latest) cannot read zip
  // archives — only bsdtar can — so `tar -xf` alone made extraction ALWAYS
  // fail on the default Linux runner and every run re-downloaded + re-failed.
  // Ordered extractor attempts: first success wins; all-fail throws below.
  /** @type {Array<[string, string[]]>} */
  const attempts =
    platform === 'win32'
      ? [
          ['tar', ['-xf', tmpArchive, '-C', extractDir]],
          [
            // PowerShell Expand-Archive is universally available on Windows
            // runners. Quoting: single quotes around the path literals.
            'powershell.exe',
            [
              '-NoProfile',
              '-Command',
              `Expand-Archive -LiteralPath '${tmpArchive}' -DestinationPath '${extractDir}' -Force`,
            ],
          ],
        ]
      : [
          ['tar', ['-xf', tmpArchive, '-C', extractDir]],
          ['unzip', ['-o', tmpArchive, '-d', extractDir]],
          ['python3', ['-m', 'zipfile', '-e', tmpArchive, `${extractDir}/`]],
        ];

  /** @type {string[]} */
  const failures = [];
  let succeeded = false;
  for (const [cmd, args] of attempts) {
    try {
      await runCommand(cmd, args);
      succeeded = true;
      break;
    } catch (err) {
      failures.push(`${cmd}: ${err?.message ?? String(err)}`);
    }
  }
  if (!succeeded) {
    // Best-effort cleanup before rethrowing.
    await fs.unlink(tmpArchive).catch(() => {});
    await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(
      `zipExtractor: all extraction attempts failed on platform=${platform}: ` +
        failures.join('; '),
    );
  }

  // Best-effort cleanup of the temp archive.
  try {
    await fs.unlink(tmpArchive);
  } catch {
    /* best-effort */
  }

  return finalizeExtraction(extractDir, destPath, deps);
}

/**
 * Dispatch helper: pick the right extractor based on a URL's extension.
 * `.zip` → zipExtractor; `.tar.gz` / `.tgz` → tarGzExtractor; otherwise
 * returns `null` (caller should use the default raw-binary path).
 *
 * @param {string} url
 * @returns {((bytes: Buffer, destPath: string, deps: Object) => Promise<string>) | null}
 */
export function pickExtractor(url) {
  if (typeof url !== 'string' || url.length === 0) return null;
  const lower = url.toLowerCase();
  if (lower.endsWith('.zip')) return zipExtractor;
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return tarGzExtractor;
  return null;
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
  const readFile = resolveReadFile(deps);
  const rm = resolveRm(deps);
  if (typeof stat === 'function') {
    let cacheHit = false;
    try {
      await stat(cachePath);
      cacheHit = true;
    } catch {
      // File doesn't exist → fall through to fetch.
    }
    if (cacheHit) {
      // SCN-10: re-hash the cached file and compare to expectedChecksum. A
      // cached file whose hash no longer matches (tampering, partial write,
      // a different binary that overwrote the path) must NOT be trusted.
      // W13-2: for specs with an extractor (tar.gz/zip), the cached file is
      // the EXTRACTED binary, not the downloaded archive — its hash will never
      // match the archive checksum. In that case, trust the cached binary's
      // existence (the archive checksum was already verified on the original
      // download). For raw-binary specs (no extractor), the cached file IS
      // the downloaded bytes, so the checksum comparison is valid.
      if (typeof spec.extractor === 'function') {
        return cachePath;
      }
      try {
        const cached = await readFile(cachePath);
        const cachedBuf = Buffer.isBuffer(cached)
          ? cached
          : Buffer.from(/** @type {any} */ (cached));
        if (sha256Hex(cachedBuf).toLowerCase() === expectedChecksum.toLowerCase()) {
          // Cache hit + checksum verified — no fetch needed.
          return cachePath;
        }
        // Checksum mismatch on cache hit → invalidate and re-fetch below.
      } catch {
        // Read failed — fall through to re-fetch (treat as a cache miss).
      }
      // Best-effort delete of the stale/tampered cached file before re-fetch.
      try {
        await rm(cachePath);
      } catch {
        /* best-effort — re-fetch proceeds regardless */
      }
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
