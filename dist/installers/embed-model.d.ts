import type { EmbedModel } from '../models/registry.js';
export declare const EMBED_MODEL_ID = "sentence-transformers/all-MiniLM-L6-v2";
export declare const BGE_LARGE_MODEL_ID = "BAAI/bge-large-en-v1.5";
export declare const GTE_QWEN2_MODEL_ID = "Alibaba-NLP/gte-Qwen2-1.5B-instruct";
export interface InstallEmbedModelOptions {
    /** Force redownload / revalidate. */
    force?: boolean;
    /** Resolved model picked by the user. */
    model: EmbedModel;
}
export declare function installEmbedModel(opts: InstallEmbedModelOptions): Promise<void>;
