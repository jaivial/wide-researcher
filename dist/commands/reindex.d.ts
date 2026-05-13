export interface ReindexOptions {
    cwd?: string;
    /** Skip the hash check; re-embed every file regardless. */
    force?: boolean;
}
export declare function runReindex(opts?: ReindexOptions): Promise<void>;
