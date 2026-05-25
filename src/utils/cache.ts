// Lightweight two-layer cache.
//
// Layer 1 — embed cache (persistent NDJSON):
//   key = sha256(model_id + "\0" + text) → vector
//   loaded into memory on first read, mutations appended atomically.
//
// Layer 2 — result cache (in-memory only):
//   key = sha256(canonical_request_json) → { payload, expiresAt }
//   TTL 5 min, invalidated when Qdrant `points_count` changes.
//
// Both caches are best-effort: any disk error falls back to "no cache",
// never blocks the search path.

import { createHash } from 'node:crypto';
import { promises as fs, mkdirSync } from 'node:fs';
import path from 'node:path';

import { globalRoot } from './paths.js';

const CACHE_DIR = path.join(globalRoot(), 'cache');
const EMBED_FILE = path.join(CACHE_DIR, 'embed.ndjson');

const EMBED_MAX_ENTRIES = 20_000;
const RESULT_TTL_MS = 5 * 60 * 1000;
const RESULT_MAX_ENTRIES = 512;

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/* ── embed cache (persistent) ───────────────────────────────────────── */

const embedMem = new Map<string, number[]>();
let embedLoaded = false;
let embedDirty = false;

async function loadEmbed(): Promise<void> {
  if (embedLoaded) return;
  embedLoaded = true;
  try {
    const raw = await fs.readFile(EMBED_FILE, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as { k: string; v: number[] };
        if (typeof entry.k === 'string' && Array.isArray(entry.v)) {
          embedMem.set(entry.k, entry.v);
        }
      } catch {
        /* skip malformed lines */
      }
    }
  } catch {
    /* missing file — first run */
  }
}

async function appendEmbedEntry(key: string, vec: number[]): Promise<void> {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const line = JSON.stringify({ k: key, v: vec }) + '\n';
    await fs.appendFile(EMBED_FILE, line, 'utf8');
  } catch (e) {
    process.stderr.write(`[wide-researcher cache] embed append failed: ${(e as Error).message}\n`);
  }
}

async function compactEmbed(): Promise<void> {
  if (!embedDirty) return;
  embedDirty = false;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = EMBED_FILE + '.tmp';
    const lines: string[] = [];
    for (const [k, v] of embedMem) lines.push(JSON.stringify({ k, v }));
    await fs.writeFile(tmp, lines.join('\n') + '\n', 'utf8');
    await fs.rename(tmp, EMBED_FILE);
  } catch (e) {
    process.stderr.write(`[wide-researcher cache] embed compact failed: ${(e as Error).message}\n`);
  }
}

export async function getEmbed(modelId: string, text: string): Promise<number[] | null> {
  await loadEmbed();
  const key = sha256(`${modelId}\0${text}`);
  return embedMem.get(key) ?? null;
}

export async function putEmbed(modelId: string, text: string, vec: number[]): Promise<void> {
  await loadEmbed();
  const key = sha256(`${modelId}\0${text}`);
  if (embedMem.has(key)) return;
  embedMem.set(key, vec);
  embedDirty = true;
  await appendEmbedEntry(key, vec);
  if (embedMem.size > EMBED_MAX_ENTRIES) {
    // Drop the oldest 25% (insertion order = roughly LRU since we don't reorder on read).
    const evict = Math.floor(EMBED_MAX_ENTRIES * 0.25);
    let i = 0;
    for (const k of embedMem.keys()) {
      if (i++ >= evict) break;
      embedMem.delete(k);
    }
    await compactEmbed();
  }
}

/* ── result cache (in-memory, TTL) ──────────────────────────────────── */

interface ResultEntry {
  payload: string;
  expiresAt: number;
  pointsCount: number;
}

const resultMem = new Map<string, ResultEntry>();

function resultKey(parts: Record<string, unknown>): string {
  // Canonicalise: sort top-level keys for deterministic hashing across call sites.
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(parts).sort()) sorted[k] = parts[k];
  return sha256(JSON.stringify(sorted));
}

export function getResult(parts: Record<string, unknown>, pointsCount: number): string | null {
  const key = resultKey(parts);
  const entry = resultMem.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    resultMem.delete(key);
    return null;
  }
  if (entry.pointsCount !== pointsCount) {
    // Index mutated → stale.
    resultMem.delete(key);
    return null;
  }
  return entry.payload;
}

export function putResult(
  parts: Record<string, unknown>,
  pointsCount: number,
  payload: string,
): void {
  const key = resultKey(parts);
  resultMem.set(key, {
    payload,
    expiresAt: Date.now() + RESULT_TTL_MS,
    pointsCount,
  });
  if (resultMem.size > RESULT_MAX_ENTRIES) {
    const evict = Math.floor(RESULT_MAX_ENTRIES * 0.25);
    let i = 0;
    for (const k of resultMem.keys()) {
      if (i++ >= evict) break;
      resultMem.delete(k);
    }
  }
}

/* ── stats ──────────────────────────────────────────────────────────── */

export function cacheStats(): { embed_entries: number; result_entries: number; embed_loaded: boolean } {
  return {
    embed_entries: embedMem.size,
    result_entries: resultMem.size,
    embed_loaded: embedLoaded,
  };
}
