import { type EmbedModel, type EmbedProvider } from '../models/registry.js';
export interface PickEmbedModelOptions {
    /** Skip the interactive picker; use this provider directly. */
    forceProvider?: EmbedProvider;
    /** Skip API-key prompt; use this value (for CI / scripted installs). */
    apiKey?: string;
    /** Project cwd — used to detect existing collection + offer backup. */
    cwd?: string;
    /** Skip the "reindex required, proceed?" reconfirmation prompt. */
    noConfirmReindex?: boolean;
    /** Skip the "restore from previous backup?" prompt. */
    noOfferRestore?: boolean;
}
export interface PickEmbedModelResult {
    model: EmbedModel;
    /** Set when the chosen model required a key + we just stored it. */
    apiKeyStored?: boolean;
    /** Path to a saved snapshot of the old collection (if we just snapshotted). */
    oldCollectionBackup?: string;
    /** Path to a previously-saved snapshot we should restore from. */
    restoreFromBackup?: string;
}
export declare function pickEmbedModel(opts?: PickEmbedModelOptions): Promise<PickEmbedModelResult>;
