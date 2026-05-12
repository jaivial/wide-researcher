// Pluggable embed-model registry. Add new providers here; the rest
// of the pipeline branches on `provider`.

export type EmbedProvider = 'local-minilm' | 'cohere';

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

export const EMBED_MODELS: Record<EmbedProvider, EmbedModel> = {
  'local-minilm': {
    provider: 'local-minilm',
    label: 'MiniLM-L6 (free, local)',
    description:
      'sentence-transformers/all-MiniLM-L6-v2 — 384-d, CPU-only, ~80 MB download, ~30 ms warm. No API key, no internet at query time.',
    embedDim: 384,
    modelId: 'sentence-transformers/all-MiniLM-L6-v2',
    requiresApiKey: false,
    pricingNote: 'free',
  },
  cohere: {
    provider: 'cohere',
    label: 'Cohere Embed v4 (paid, cloud API)',
    description:
      'cohere embed-v4.0 — 1536-d, top-tier multilingual + code semantics, ~30-50 ms latency. Requires Cohere production API key. Indexing cost ≈ $0.10 / 1M tokens.',
    embedDim: 1536,
    modelId: 'embed-v4.0',
    requiresApiKey: true,
    apiKeySecretField: 'cohere_api_key',
    pricingNote: '~$0.10 / 1M input tokens',
  },
};

export function modelById(provider: EmbedProvider): EmbedModel {
  const m = EMBED_MODELS[provider];
  if (!m) throw new Error(`Unknown embed provider: ${provider}`);
  return m;
}

export const DEFAULT_PROVIDER: EmbedProvider = 'local-minilm';
