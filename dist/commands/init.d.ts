import type { EmbedProvider } from '../models/registry.js';
export interface InitOptions {
    cwd?: string;
    force?: boolean;
    noWatch?: boolean;
    noSupervisor?: boolean;
    /** Skip the initial reindex (useful for smoke tests). */
    noReindex?: boolean;
    /** Skip the global qdrant + venv + model install (used by `add`). */
    onlyProject?: boolean;
    /** Non-interactive: force provider (skip picker). */
    embedProvider?: EmbedProvider;
    /** Non-interactive: pre-supplied Cohere API key. */
    cohereApiKey?: string;
}
export declare function runInit(opts?: InitOptions): Promise<void>;
