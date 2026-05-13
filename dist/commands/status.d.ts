export interface StatusOptions {
    cwd?: string;
    json?: boolean;
}
interface StatusReport {
    project: {
        name: string;
        slug: string;
        root: string;
        configPath: string;
        installed: boolean;
    };
    global: {
        qdrantBinary: boolean;
    };
    qdrant: {
        reachable: boolean;
        url: string;
        collection: string;
        pointsCount?: number;
        vectorSize?: number;
        statusColor?: string;
    };
    indexer: {
        serviceState: string;
        lastIndex: string | null;
    };
}
export declare function runStatus(opts?: StatusOptions): Promise<StatusReport>;
export {};
