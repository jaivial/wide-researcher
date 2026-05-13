export type EmbedProvider = 'local-minilm' | 'local-bge-large' | 'local-gte-qwen2' | 'cohere';
export interface EmbedModel {
    /** Internal key — drives the provider branch in Python + Node. */
    provider: EmbedProvider;
    /** Display label for the CLI picker. */
    label: string;
    /** One-line description for the picker. */
    description: string;
    /** Vector dimensionality the model produces (drives Qdrant collection config). */
    embedDim: number;
    /** Model identifier (HuggingFace repo for local, model name for API providers). */
    modelId: string;
    /** Does this provider need an API key in `secrets.json`? */
    requiresApiKey: boolean;
    /** Which secrets.json field holds the key (only meaningful when requiresApiKey). */
    apiKeySecretField?: 'cohere_api_key';
    /** Approx pricing per 1M tokens — for the picker description only. */
    pricingNote?: string;
}
export declare const EMBED_MODELS: Record<EmbedProvider, EmbedModel>;
export declare function modelById(provider: EmbedProvider): EmbedModel;
export declare const DEFAULT_PROVIDER: EmbedProvider;
