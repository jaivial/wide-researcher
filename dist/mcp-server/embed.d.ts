export interface EmbedWorkerOptions {
    pythonPath: string;
    scriptPath: string;
    /** Forwarded to the worker as WIDE_RESEARCHER_PROJECT_CONFIG so the
     *  worker pulls the same embed-model path the indexer is using. */
    projectConfigPath: string;
    embedProvider: string;
    embedModel: string;
    embedDim: number;
    secretsPath: string | null;
    cohereApiKeyField: string;
}
export declare class EmbedWorker {
    private readonly pythonPath;
    private readonly scriptPath;
    private readonly projectConfigPath;
    private readonly embedProvider;
    private readonly embedModel;
    private readonly embedDim;
    private readonly secretsPath;
    private readonly cohereApiKeyField;
    private queue;
    private ready;
    private closed;
    private proc;
    private readyResolvers;
    constructor(opts: EmbedWorkerOptions);
    private _loadCohereApiKey;
    private _start;
    waitReady(timeoutMs?: number): Promise<void>;
    private cacheKey;
    embed(query: string): Promise<number[]>;
    rerank(query: string, docs: string[]): Promise<number[]>;
    close(): Promise<void>;
}
