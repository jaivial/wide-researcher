// Pluggable embed-model registry. Add new providers here; the rest
// of the pipeline branches on `provider`.
export const EMBED_MODELS = {
    'local-minilm': {
        provider: 'local-minilm',
        label: 'MiniLM-L6 (free, local)',
        description: 'sentence-transformers/all-MiniLM-L6-v2 — 384-d, CPU-only, ~80 MB download, ~30 ms warm. No API key, no internet at query time.',
        embedDim: 384,
        modelId: 'sentence-transformers/all-MiniLM-L6-v2',
        requiresApiKey: false,
        pricingNote: 'free',
    },
    'local-bge-large': {
        provider: 'local-bge-large',
        label: 'BGE-Large-en-v1.5 (free, local)',
        description: 'BAAI/bge-large-en-v1.5 — 1024-d, English, 512 token context. ~1.3 GB download. 55% better than MiniLM. CPU-only.',
        embedDim: 1024,
        modelId: 'BAAI/bge-large-en-v1.5',
        requiresApiKey: false,
        pricingNote: 'free',
    },
    'local-gte-qwen2': {
        provider: 'local-gte-qwen2',
        label: 'GTE-Qwen2-1.5B (free, local)',
        description: 'Alibaba-NLP/gte-Qwen2-1.5B-instruct — 1536-d, multilingual, 32K context. ~1.5 GB download. Matches Cohere v4 quality at zero cost. CPU-only (slow on first query).',
        embedDim: 1536,
        modelId: 'Alibaba-NLP/gte-Qwen2-1.5B-instruct',
        requiresApiKey: false,
        pricingNote: 'free',
    },
    cohere: {
        provider: 'cohere',
        label: 'Cohere Embed v4 (paid, cloud API)',
        description: 'cohere embed-v4.0 — 1536-d, top-tier multilingual + code semantics, ~30-50 ms latency. Requires Cohere production API key. Indexing cost ≈ $0.10 / 1M tokens.',
        embedDim: 1536,
        modelId: 'embed-v4.0',
        requiresApiKey: true,
        apiKeySecretField: 'cohere_api_key',
        pricingNote: '~$0.10 / 1M input tokens',
    },
};
export function modelById(provider) {
    const m = EMBED_MODELS[provider];
    if (!m)
        throw new Error(`Unknown embed provider: ${provider}`);
    return m;
}
export const DEFAULT_PROVIDER = 'local-minilm';
//# sourceMappingURL=registry.js.map