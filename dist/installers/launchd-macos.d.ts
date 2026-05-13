export interface InstallQdrantServiceOptions {
    force?: boolean;
}
export declare function installQdrantServiceMacOS(opts?: InstallQdrantServiceOptions): Promise<void>;
export declare function uninstallQdrantServiceMacOS(): Promise<void>;
export interface InstallIndexerServiceOptions {
    slug: string;
    projectName: string;
    projectConfigPath: string;
    force?: boolean;
}
export declare function installIndexerServiceMacOS(opts: InstallIndexerServiceOptions): Promise<void>;
export declare function uninstallIndexerServiceMacOS(slug: string): Promise<void>;
