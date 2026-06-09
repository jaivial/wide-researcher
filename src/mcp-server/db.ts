// Qdrant client singleton. Reads URL + collection from the project
// config supplied to the MCP server via argv.

import { QdrantClient } from '@qdrant/js-client-rest';

import { loadProjectConfig } from './config.js';

const cfg = loadProjectConfig();

export const PROJECT_CONFIG = cfg;
export const COLLECTION = cfg.collectionName;
export const QDRANT_URL = cfg.qdrantUrl;
export const PROJECT_ROOT = cfg.projectRoot;
export const SKILLS_COLLECTION = `${cfg.collectionName}_skills`;
export const MEMORIES_COLLECTION = 'memories';

export const qdrant = new QdrantClient({ url: QDRANT_URL });

/**
 * Resolve a base collection name (from a tool's optional `collection`
 * override) into the full family used by the index: the base code
 * collection plus its derived `_symbols` and `_skills` siblings.
 *
 * Omitted/blank → falls back to the project default (`COLLECTION`),
 * so existing callers keep their behavior unchanged.
 */
export function resolveCollection(base?: string | null): {
  base: string;
  symbols: string;
  skills: string;
} {
  const b = base && base.trim() ? base.trim() : COLLECTION;
  return { base: b, symbols: `${b}_symbols`, skills: `${b}_skills` };
}
