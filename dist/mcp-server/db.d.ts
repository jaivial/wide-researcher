import { QdrantClient } from '@qdrant/js-client-rest';
export declare const PROJECT_CONFIG: import("./config.js").ProjectConfig;
export declare const COLLECTION: string;
export declare const QDRANT_URL: string;
export declare const PROJECT_ROOT: string;
export declare const SKILLS_COLLECTION: string;
export declare const MEMORIES_COLLECTION = "memories";
export declare const qdrant: QdrantClient;
/**
 * Resolve a base collection name (from a tool's optional `collection`
 * override) into the full family used by the index: the base code
 * collection plus its derived `_symbols` and `_skills` siblings.
 *
 * Omitted/blank → falls back to the project default (`COLLECTION`),
 * so existing callers keep their behavior unchanged.
 */
export declare function resolveCollection(base?: string | null): {
    base: string;
    symbols: string;
    skills: string;
};
