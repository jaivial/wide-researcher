export interface EmbedWorkerOptions {
    pythonPath: string;
    scriptPath: string;
    /** Forwarded to the worker as WIDE_RESEARCHER_PROJECT_CONFIG so the
     *  worker pulls the same embed-model path the indexer is using. */
    projectConfigPath: string;
}
export declare class EmbedWorker {
    private readonly pythonPath;
    private readonly scriptPath;
    private readonly projectConfigPath;
    private queue;
    private ready;
    private closed;
    private proc;
    private readyResolvers;
    constructor(opts: EmbedWorkerOptions);
    private _start;
    waitReady(timeoutMs?: number): Promise<void>;
    embed(query: string): Promise<number[]>;
    close(): Promise<void>;
}
