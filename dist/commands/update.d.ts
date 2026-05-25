export interface UpdateOptions {
    /** Project root. Defaults to cwd. */
    cwd?: string;
    /** Skip the `pip install -U -r requirements.txt` step. */
    noPipUpgrade?: boolean;
    /** Skip the watcher service restart. */
    noRestart?: boolean;
    /** Skip the systemd/launchd unit refresh. */
    noSupervisor?: boolean;
}
export declare function runUpdate(opts?: UpdateOptions): Promise<void>;
