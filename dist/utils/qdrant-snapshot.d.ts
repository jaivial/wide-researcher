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
export declare function getCollectionInfo(collection: string, url?: string): Promise<CollectionInfo>;
/**
 * Create a qdrant-side snapshot, then move it into our backup dir
 * so it survives `init --force` (which drops the collection).
 *
 * Returns the absolute path to the saved snapshot file.
 */
export declare function snapshotCollection(collection: string, provider: string, url?: string): Promise<string>;
/**
 * List all backups for this collection slug, newest first.
 */
export declare function listBackups(slug: string): Promise<SnapshotEntry[]>;
/**
 * Find the most recent backup for a (slug, provider) pair, if any.
 */
export declare function findLatestBackup(slug: string, provider: string): Promise<SnapshotEntry | null>;
/**
 * Restore a collection from a saved snapshot file via Qdrant's
 * `snapshots/upload` endpoint.
 *
 * Important: qdrant restore creates the collection — caller should
 * NOT have already recreated it. If a collection of that name
 * already exists, delete it first.
 */
export declare function restoreFromSnapshot(collection: string, snapshotPath: string, url?: string): Promise<void>;
