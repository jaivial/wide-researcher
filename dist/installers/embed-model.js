// Embed-model installer — branches by provider.
//
// - `local-minilm`: download MiniLM via huggingface_hub, verify load
// - `local-gte-qwen2`: download GTE-Qwen2-1.5B, verify load
// - `cohere`: nothing to download; verify the API key works
//
// Idempotent: skips download if model dir exists AND can be
// loaded inside the wide-researcher venv.
import path from 'node:path';
import { run } from '../utils/exec.js';
import { log } from '../utils/log.js';
import { ensureDir, exists, miniLMPath, bgeLargePath, gteQwen2Path, modelsRoot, pyPackageRoot, venvPython, } from '../utils/paths.js';
import { getSecret } from '../utils/secrets.js';
export const EMBED_MODEL_ID = 'sentence-transformers/all-MiniLM-L6-v2';
export const BGE_LARGE_MODEL_ID = 'BAAI/bge-large-en-v1.5';
export const GTE_QWEN2_MODEL_ID = 'Alibaba-NLP/gte-Qwen2-1.5B-instruct';
// ── MiniLM-L6 ──────────────────────────────────────────────────────────
async function miniLMHealthy() {
    if (!(await exists(miniLMPath())))
        return false;
    try {
        await run(venvPython(), [
            '-c',
            `from sentence_transformers import SentenceTransformer\n` +
                `m = SentenceTransformer(${JSON.stringify(miniLMPath())}, device='cpu')\n` +
                `_ = m.encode(['probe'], show_progress_bar=False)\n` +
                `print('ok')`,
        ], { capture: true });
        return true;
    }
    catch {
        return false;
    }
}
async function installMiniLM(force) {
    await ensureDir(modelsRoot());
    if (!force && (await miniLMHealthy())) {
        log.skip(`MiniLM-L6 already installed at ${miniLMPath()}`);
        return;
    }
    log.step(`downloading ${EMBED_MODEL_ID} (~80 MB)`);
    const code = `from huggingface_hub import snapshot_download\n` +
        `snapshot_download(\n` +
        `    repo_id=${JSON.stringify(EMBED_MODEL_ID)},\n` +
        `    local_dir=${JSON.stringify(miniLMPath())},\n` +
        `    local_dir_use_symlinks=False,\n` +
        `)\n` +
        `print('downloaded:', ${JSON.stringify(miniLMPath())})\n`;
    await run(venvPython(), ['-c', code], { echo: true });
    if (!(await miniLMHealthy())) {
        throw new Error(`MiniLM downloaded but failed to load. Inspect ${miniLMPath()} and re-run with --force.`);
    }
    log.ok(`MiniLM-L6 ready at ${miniLMPath()}`);
}
// ── BGE-Large-en-v1.5 ──────────────────────────────────────────────────
async function bgeLargeHealthy() {
    if (!(await exists(bgeLargePath())))
        return false;
    try {
        await run(venvPython(), [
            '-c',
            `from sentence_transformers import SentenceTransformer\n` +
                `m = SentenceTransformer(${JSON.stringify(bgeLargePath())}, device='cpu')\n` +
                `_ = m.encode(['probe'], show_progress_bar=False)\n` +
                `print('ok')`,
        ], { capture: true });
        return true;
    }
    catch {
        return false;
    }
}
async function installBgeLarge(force) {
    await ensureDir(modelsRoot());
    if (!force && (await bgeLargeHealthy())) {
        log.skip(`BGE-Large already installed at ${bgeLargePath()}`);
        return;
    }
    log.step(`downloading ${BGE_LARGE_MODEL_ID} (~1.3 GB)`);
    const code = `from huggingface_hub import snapshot_download\n` +
        `snapshot_download(\n` +
        `    repo_id=${JSON.stringify(BGE_LARGE_MODEL_ID)},\n` +
        `    local_dir=${JSON.stringify(bgeLargePath())},\n` +
        `)\n` +
        `print('downloaded:', ${JSON.stringify(bgeLargePath())})\n`;
    await run(venvPython(), ['-c', code], { echo: true });
    if (!(await bgeLargeHealthy())) {
        throw new Error(`BGE-Large downloaded but failed to load. Inspect ${bgeLargePath()} and re-run with --force.`);
    }
    log.ok(`BGE-Large-en-v1.5 ready at ${bgeLargePath()}`);
}
// ── GTE-Qwen2-1.5B ────────────────────────────────────────────────────
async function gteQwen2Healthy() {
    if (!(await exists(gteQwen2Path())))
        return false;
    try {
        await run(venvPython(), [
            '-c',
            `from sentence_transformers import SentenceTransformer\n` +
                `m = SentenceTransformer(${JSON.stringify(gteQwen2Path())}, device='cpu', trust_remote_code=False)\n` +
                `_ = m.encode(['probe'], show_progress_bar=False)\n` +
                `print('ok')`,
        ], { capture: true });
        return true;
    }
    catch {
        return false;
    }
}
async function installGteQwen2(force) {
    await ensureDir(modelsRoot());
    if (!force && (await gteQwen2Healthy())) {
        log.skip(`GTE-Qwen2-1.5B already installed at ${gteQwen2Path()}`);
        return;
    }
    log.step(`downloading ${GTE_QWEN2_MODEL_ID} (~1.5 GB — this takes a few minutes)`);
    const code = `from huggingface_hub import snapshot_download\n` +
        `snapshot_download(\n` +
        `    repo_id=${JSON.stringify(GTE_QWEN2_MODEL_ID)},\n` +
        `    local_dir=${JSON.stringify(gteQwen2Path())},\n` +
        `    local_dir_use_symlinks=False,\n` +
        `)\n` +
        `print('downloaded:', ${JSON.stringify(gteQwen2Path())})\n`;
    await run(venvPython(), ['-c', code], { echo: true });
    if (!(await gteQwen2Healthy())) {
        throw new Error(`GTE-Qwen2 downloaded but failed to load. Inspect ${gteQwen2Path()} and re-run with --force.`);
    }
    log.ok(`GTE-Qwen2-1.5B ready at ${gteQwen2Path()}`);
}
// ── Cohere ──────────────────────────────────────────────────────────────
async function installCohere(model) {
    const key = await getSecret('cohere_api_key');
    if (!key || key.length < 20) {
        throw new Error(`Cohere selected but no API key in ~/.wide-researcher/secrets.json. ` +
            `Re-run \`wide-researcher init\` and complete the embed-model picker.`);
    }
    log.step(`Cohere ${model.modelId} — no local model to download. Verifying API.`);
    const probeScript = path.join(pyPackageRoot(), 'scripts', 'probe_cohere.py');
    await run(venvPython(), [probeScript], { echo: true, env: { ...process.env, COHERE_API_KEY: key, COHERE_EMBED_MODEL: model.modelId } });
    log.ok(`Cohere ${model.modelId} ready (API key validated)`);
}
export async function installEmbedModel(opts) {
    switch (opts.model.provider) {
        case 'local-minilm':
            await installMiniLM(!!opts.force);
            return;
        case 'local-bge-large':
            await installBgeLarge(!!opts.force);
            return;
        case 'local-gte-qwen2':
            await installGteQwen2(!!opts.force);
            return;
        case 'cohere':
            await installCohere(opts.model);
            return;
        default:
            throw new Error(`Unsupported provider: ${opts.model.provider}`);
    }
}
//# sourceMappingURL=embed-model.js.map