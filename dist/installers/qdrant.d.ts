/** Pin Qdrant to a known-good release. Bump deliberately. */
export declare const QDRANT_VERSION = "1.18.0";
export interface InstallQdrantOptions {
    /** Force re-download even if a working binary is already present. */
    force?: boolean;
}
export declare function installQdrant(opts?: InstallQdrantOptions): Promise<void>;
