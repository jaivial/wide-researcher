// Qdrant binary installer.
//
// • Idempotent: skips download + extract if `qdrant` already lives at
//   `~/.wide-researcher/qdrant/qdrant` and `--version` runs.
// • Downloads the upstream release tarball for the host triple.
// • Verifies the binary by spawning `qdrant --version`.
// • Writes a per-user `config.yaml` with the storage dir pinned to
//   `~/.wide-researcher/qdrant/storage/`.

import { createWriteStream, promises as fs } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { extract as tarExtract } from 'tar';
import AdmZip from 'adm-zip';

import { detectPlatform } from '../utils/platform.js';
import { run } from '../utils/exec.js';
import { log } from '../utils/log.js';
import {
  ensureDir,
  exists,
  qdrantBinary,
  qdrantConfigPath,
  qdrantRoot,
  qdrantStorageRoot,
} from '../utils/paths.js';

/** Pin Qdrant to a known-good release. Bump deliberately. */
export const QDRANT_VERSION = '1.18.0';

function archiveUrl(): { url: string; ext: 'tar.gz' | 'zip' } {
  const { qdrantTriple, qdrantArchiveExt } = detectPlatform();
  // e.g.
  //   https://github.com/qdrant/qdrant/releases/download/v1.18.0/qdrant-x86_64-unknown-linux-gnu.tar.gz
  //   https://github.com/qdrant/qdrant/releases/download/v1.18.0/qdrant-x86_64-pc-windows-msvc.zip
  return {
    url:
      `https://github.com/qdrant/qdrant/releases/download/v${QDRANT_VERSION}` +
      `/qdrant-${qdrantTriple}.${qdrantArchiveExt}`,
    ext: qdrantArchiveExt,
  };
}

async function downloadArchive(toFile: string, url: string): Promise<void> {
  log.info(`downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`qdrant download failed: HTTP ${res.status} ${res.statusText} from ${url}`);
  }
  if (!res.body) {
    throw new Error(`qdrant download produced no body`);
  }
  await pipeline(
    Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>),
    createWriteStream(toFile),
  );
}

async function extractArchive(archivePath: string, ext: 'tar.gz' | 'zip', destDir: string): Promise<void> {
  if (ext === 'tar.gz') {
    await tarExtract({ file: archivePath, cwd: destDir });
    return;
  }
  // zip — adm-zip handles Windows-style entries
  const zip = new AdmZip(archivePath);
  zip.extractAllTo(destDir, /* overwrite */ true);
}

async function writeConfig(): Promise<void> {
  const yaml = [
    '# wide-researcher · qdrant per-user config',
    'log_level: INFO',
    '',
    'service:',
    '  host: 127.0.0.1',
    '  http_port: 6333',
    '  grpc_port: 6334',
    '  enable_cors: false',
    '',
    'storage:',
    `  storage_path: ${qdrantStorageRoot()}`,
    '  on_disk_payload: true',
    '',
    'cluster:',
    '  enabled: false',
    '',
  ].join('\n');
  await fs.writeFile(qdrantConfigPath(), yaml, 'utf8');
}

async function verifyBinary(): Promise<boolean> {
  try {
    const r = await run(qdrantBinary(), ['--version'], { capture: true });
    return r.stdout.toLowerCase().includes('qdrant');
  } catch {
    return false;
  }
}

export interface InstallQdrantOptions {
  /** Force re-download even if a working binary is already present. */
  force?: boolean;
}

export async function installQdrant(opts: InstallQdrantOptions = {}): Promise<void> {
  await ensureDir(qdrantRoot());
  await ensureDir(qdrantStorageRoot());

  const haveBinary = await exists(qdrantBinary());
  if (haveBinary && !opts.force) {
    const ok = await verifyBinary();
    if (ok) {
      log.skip(`qdrant already installed at ${qdrantBinary()}`);
      await writeConfig();
      return;
    }
    log.warn('qdrant binary exists but failed --version; re-downloading');
  }

  const { url, ext } = archiveUrl();
  const archive = path.join(qdrantRoot(), `qdrant-${QDRANT_VERSION}.${ext}`);
  log.step(`installing qdrant ${QDRANT_VERSION}`);
  await downloadArchive(archive, url);

  log.info(`extracting ${path.basename(archive)}`);
  await extractArchive(archive, ext, qdrantRoot());

  // Some release archives include a top-level dir; flatten by moving the
  // binary up to qdrantRoot() if necessary.
  if (!(await exists(qdrantBinary()))) {
    const binName = process.platform === 'win32' ? 'qdrant.exe' : 'qdrant';
    const entries = await fs.readdir(qdrantRoot(), { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const candidate = path.join(qdrantRoot(), e.name, binName);
      if (await exists(candidate)) {
        await fs.rename(candidate, qdrantBinary());
        break;
      }
    }
  }

  if (!(await exists(qdrantBinary()))) {
    throw new Error(
      `qdrant binary not found after extraction in ${qdrantRoot()}. Archive layout may have changed.`,
    );
  }

  // chmod is a no-op on Windows but harmless.
  try {
    await fs.chmod(qdrantBinary(), 0o755);
  } catch {
    /* ignore on Windows */
  }
  await fs.rm(archive, { force: true });

  if (!(await verifyBinary())) {
    throw new Error(`qdrant --version failed after install. See ${qdrantBinary()}.`);
  }

  await writeConfig();
  log.ok(`qdrant ${QDRANT_VERSION} installed at ${qdrantBinary()}`);
}
