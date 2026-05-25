export interface ProjectIdentity {
    /** Cosmetic name (basename of the project dir). */
    projectName: string;
    /** Deterministic slug = `<sanitised>_<sha1[0:8]>`. Used for collection name + log files. */
    slug: string;
    /** Absolute path to the project root. */
    projectRoot: string;
    /** Absolute path to `<project>/.wide-researcher/config.json`. */
    configPath: string;
}
export declare function deriveProjectIdentity(cwd?: string): ProjectIdentity;
import type { EmbedModel } from '../models/registry.js';
export interface InstallBundleOptions {
    /** Project root. Defaults to cwd. */
    cwd?: string;
    /** Re-write files even if already present. */
    force?: boolean;
    /** Resolved embed model (from the picker). */
    model: EmbedModel;
    /**
     * Used by the `update` command. Skips the project config rewrite path
     * entirely so user-customised fields (excludes, batch_size, chunk_cap)
     * survive a re-run. The embed-provider check inside writeProjectConfig
     * is fine for first-install and re-init flows but throws away custom
     * fields when force=true is set by a bulk refresh.
     */
    keepProjectConfig?: boolean;
}
export interface UninstallBundleOptions {
    /** Project root. Defaults to cwd. */
    cwd?: string;
}
export interface McpFile {
    mcpServers?: Record<string, McpServerEntry>;
}
export interface McpServerEntry {
    command: string;
    args: string[];
    env?: Record<string, string>;
}
export declare function writeMcpStanza(id: ProjectIdentity, force: boolean): Promise<void>;
export declare function installClaudeBundle(opts: InstallBundleOptions): Promise<ProjectIdentity>;
export declare function uninstallClaudeBundle(opts?: UninstallBundleOptions): Promise<void>;
