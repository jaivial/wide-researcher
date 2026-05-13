export interface UninstallOptions {
    cwd?: string;
    all?: boolean;
    dropCollection?: boolean;
}
export declare function runUninstall(opts?: UninstallOptions): Promise<void>;
