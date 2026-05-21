export interface Neo4jSyncOptions {
    cwd?: string;
    maxFiles?: number;
}
export declare function runNeo4jSync(opts?: Neo4jSyncOptions): Promise<void>;
