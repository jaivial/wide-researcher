// Qdrant snapshot helpers — used to back up a collection before a
// provider switch invalidates its vectors.
//
// Strategy:
//   1. Read collection info → vector_size, points_count
//   2. POST /collections/<name>/snapshots → qdrant writes a tarball
//      into its own snapshot dir (configurable via storage_path)
//   3. Move that tarball into ~/.wide-researcher/backups/<slug>__<provider>__<timestamp>.snapshot
//   4. To restore: POST /collections/<name>/snapshots/upload (multipart)
//      OR drop the collection + recreate from snapshot URL
//
// All HTTP via plain fetch (Qdrant exposes REST on the same port we
// already use for search).

import path from 'node:path';
import { promises as fs } from 'node:fs';

import { ensureDir, exists, globalRoot } from './paths.js';
import { log } from './log.js';

export interface CollectionInfo {
  exists: boolean;
  vectorSize?: number;
  pointsCount?: number;
  status?: string;
}

export interface SnapshotEntry {
  /** Backup filename — `<slug>__<provider>__<timestamp>.snapshot`. */
  filename: string;
  /** Absolute path on disk. */
  absPath: string;
  /** Parsed slug, provider, timestamp from the filename. */
  slug: string;
  provider: string;
  /** ISO timestamp string from filename. */
  timestamp: string;
}

function backupsDir(): string {
  return path.join(globalRoot(), 'backups');
}

function qdrantUrl(url: string = 'http://127.0.0.1:6333'): string {
  return url;
}

export async function getCollectionInfo(
  collection: string,
  url?: string,
): Promise<CollectionInfo> {
  try {
    const res = await fetch(`${qdrantUrl(url)}/collections/${collection}`, {
      method: 'GET',
    });
    if (res.status === 404) return { exists: false };
    if (!res.ok) return { exists: false };
    const body = (await res.json()) as {
      result?: {
        points_count?: number;
        status?: string;
        config?: { params?: { vectors?: { size?: number } } };
      };
    };
    return {
      exists: true,
      vectorSize: body.result?.config?.params?.vectors?.size,
      pointsCount: body.result?.points_count,
      status: body.result?.status,
    };
  } catch {
    return { exists: false };
  }
}

/**
 * Create a qdrant-side snapshot, then move it into our backup dir
 * so it survives `init --force` (which drops the collection).
 *
 * Returns the absolute path to the saved snapshot file.
 */
export async function snapshotCollection(
  collection: string,
  provider: string,
  url?: string,
): Promise<string> {
  await ensureDir(backupsDir());
  const u = qdrantUrl(url);

  log.step(`taking qdrant snapshot of ${collection} (provider=${provider})`);
  const res = await fetch(`${u}/collections/${collection}/snapshots`, {
    method: 'POST',
  });
  if (!res.ok) {
    throw new Error(
      `snapshot failed: HTTP ${res.status} ${res.statusText} from ${u}`,
    );
  }
  const body = (await res.json()) as {
    result?: { name?: string };
  };
  const snapshotName = body.result?.name;
  if (!snapshotName) {
    throw new Error('snapshot response missing result.name');
  }

  // Download the snapshot via /collections/<name>/snapshots/<filename>
  const dlRes = await fetch(`${u}/collections/${collection}/snapshots/${snapshotName}`);
  if (!dlRes.ok) {
    throw new Error(`snapshot download failed: HTTP ${dlRes.status}`);
  }
  const buf = Buffer.from(await dlRes.arrayBuffer());

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const fname = `${collection}__${provider}__${ts}.snapshot`;
  const dst = path.join(backupsDir(), fname);
  await fs.writeFile(dst, buf);
  // chmod 600 — these contain the user's embedded code, treat as sensitive
  try {
    await fs.chmod(dst, 0o600);
  } catch {
    /* ignore on Windows */
  }

  log.ok(`backup saved: ${dst} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);

  // Tell qdrant it can delete its server-side copy now (we have our own)
  try {
    await fetch(`${u}/collections/${collection}/snapshots/${snapshotName}`, {
      method: 'DELETE',
    });
  } catch {
    /* non-fatal */
  }

  return dst;
}

/**
 * List all backups for this collection slug, newest first.
 */
export async function listBackups(slug: string): Promise<SnapshotEntry[]> {
  if (!(await exists(backupsDir()))) return [];
  const entries = await fs.readdir(backupsDir());
  const out: SnapshotEntry[] = [];
  for (const f of entries) {
    if (!f.endsWith('.snapshot')) continue;
    // filename pattern: <slug>__<provider>__<timestamp>.snapshot
    const stem = f.replace(/\.snapshot$/, '');
    const parts = stem.split('__');
    if (parts.length < 3) continue;
    const fileSlug = parts[0]!;
    const provider = parts[1]!;
    const timestamp = parts.slice(2).join('__');
    if (fileSlug !== slug) continue;
    out.push({
      filename: f,
      absPath: path.join(backupsDir(), f),
      slug: fileSlug,
      provider,
      timestamp,
    });
  }
  // newest first
  out.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return out;
}

/**
 * Find the most recent backup for a (slug, provider) pair, if any.
 */
export async function findLatestBackup(
  slug: string,
  provider: string,
): Promise<SnapshotEntry | null> {
  const all = await listBackups(slug);
  return all.find((b) => b.provider === provider) ?? null;
}

/**
 * Restore a collection from a saved snapshot file via Qdrant's
 * `snapshots/upload` endpoint.
 *
 * Important: qdrant restore creates the collection — caller should
 * NOT have already recreated it. If a collection of that name
 * already exists, delete it first.
 */
export async function restoreFromSnapshot(
  collection: string,
  snapshotPath: string,
  url?: string,
): Promise<void> {
  const u = qdrantUrl(url);

  // Drop any existing collection with this name
  await fetch(`${u}/collections/${collection}`, { method: 'DELETE' });

  log.step(`restoring ${collection} from ${snapshotPath}`);
  const buf = await fs.readFile(snapshotPath);
  // Qdrant accepts multipart upload OR a local-path / URL pointer.
  // Easiest cross-platform path: PUT the bytes directly via the
  // /snapshots/recover endpoint with `location` pointing at a
  // file:// URL.
  // BUT — that requires the file to be accessible from qdrant's
  // perspective. Since we run qdrant locally on the same machine,
  // file:// works.
  const recoverRes = await fetch(
    `${u}/collections/${collection}/snapshots/recover`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: `file://${snapshotPath}`,
        priority: 'snapshot',
      }),
    },
  );
  if (!recoverRes.ok) {
    const errBody = await recoverRes.text().catch(() => '');
    throw new Error(
      `snapshot restore failed: HTTP ${recoverRes.status} — ${errBody.slice(0, 300)}`,
    );
  }
  void buf;
  log.ok(`restored ${collection} from snapshot`);
}
