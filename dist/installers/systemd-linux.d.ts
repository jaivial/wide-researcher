export interface InstallQdrantServiceOptions {
    /** Re-render + reload + restart even if the unit is already present. */
    force?: boolean;
}
export declare function installQdrantServiceLinux(opts?: InstallQdrantServiceOptions): Promise<void>;
export declare function uninstallQdrantServiceLinux(): Promise<void>;
export interface InstallIndexerServiceOptions {
    /** Stable slug for the project (filename-safe). */
    slug: string;
    /** Human-readable project name (cosmetic — goes in Description=). */
    projectName: string;
    /** Absolute path to the project's `.wide-researcher/config.json`. */
    projectConfigPath: string;
    force?: boolean;
}
export declare function installIndexerServiceLinux(opts: InstallIndexerServiceOptions): Promise<void>;
export declare function uninstallIndexerServiceLinux(slug: string): Promise<void>;
