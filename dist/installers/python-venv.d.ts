export interface InstallVenvOptions {
    /** Force recreate the venv even if it already imports cleanly. */
    force?: boolean;
}
export declare function installPythonVenv(opts?: InstallVenvOptions): Promise<void>;
