export interface SupervisorOptions {
    force?: boolean;
}
export declare function installQdrantSupervisor(opts?: SupervisorOptions): Promise<void>;
export declare function uninstallQdrantSupervisor(): Promise<void>;
export interface IndexerSupervisorOptions extends SupervisorOptions {
    slug: string;
    projectName: string;
    projectConfigPath: string;
}
export declare function installIndexerSupervisor(opts: IndexerSupervisorOptions): Promise<void>;
export declare function uninstallIndexerSupervisor(slug: string): Promise<void>;
