// Embed-model installer — branches by provider.
//
// - `local-minilm`: download MiniLM via huggingface_hub, verify load
// - `cohere`: nothing to download; verify the API key works
//
// Idempotent: skips download if MiniLM model dir exists AND can be
// loaded inside the wide-researcher venv.

import { run } from '../utils/exec.js';
import { log } from '../utils/log.js';
import {
  ensureDir,
  exists,
  miniLMPath,
  modelsRoot,
  venvPython,
} from '../utils/paths.js';
import type { EmbedModel } from '../models/registry.js';
import { getSecret } from '../utils/secrets.js';

export const EMBED_MODEL_ID = 'sentence-transformers/all-MiniLM-L6-v2';

async function miniLMHealthy(): Promise<boolean> {
  if (!(await exists(miniLMPath()))) return false;
  try {
    await run(
      venvPython(),
      [
        '-c',
        `from sentence_transformers import SentenceTransformer\n` +
          `m = SentenceTransformer(${JSON.stringify(miniLMPath())}, device='cpu')\n` +
          `_ = m.encode(['probe'], show_progress_bar=False)\n` +
          `print('ok')`,
      ],
      { capture: true },
    );
    return true;
  } catch {
    return false;
  }
}

async function installMiniLM(force: boolean): Promise<void> {
  await ensureDir(modelsRoot());

  if (!force && (await miniLMHealthy())) {
    log.skip(`MiniLM-L6 already installed at ${miniLMPath()}`);
    return;
  }

  log.step(`downloading ${EMBED_MODEL_ID} (~80 MB)`);
  const code =
    `from huggingface_hub import snapshot_download\n` +
    `snapshot_download(\n` +
    `    repo_id=${JSON.stringify(EMBED_MODEL_ID)},\n` +
    `    local_dir=${JSON.stringify(miniLMPath())},\n` +
    `    local_dir_use_symlinks=False,\n` +
    `)\n` +
    `print('downloaded:', ${JSON.stringify(miniLMPath())})\n`;

  await run(venvPython(), ['-c', code], { echo: true });

  if (!(await miniLMHealthy())) {
    throw new Error(
      `MiniLM downloaded but failed to load. Inspect ${miniLMPath()} and re-run with --force.`,
    );
  }

  log.ok(`MiniLM-L6 ready at ${miniLMPath()}`);
}

async function installCohere(model: EmbedModel): Promise<void> {
  const key = await getSecret('cohere_api_key');
  if (!key || key.length < 20) {
    throw new Error(
      `Cohere selected but no API key in ~/.wide-researcher/secrets.json. ` +
        `Re-run \`wide-researcher init\` and complete the embed-model picker.`,
    );
  }
  log.step(`Cohere ${model.modelId} — no local model to download. Verifying API.`);

  // Live probe inside the venv (so the same `cohere` lib that the
  // indexer will use is the one that gets validated).
  await run(
    venvPython(),
    [
      '-c',
      `import os, sys\n` +
        `try:\n` +
        `    import cohere\n` +
        `except ImportError:\n` +
        `    print('cohere library missing', file=sys.stderr)\n` +
        `    sys.exit(2)\n` +
        `client = cohere.ClientV2(${JSON.stringify(key)})\n` +
        `r = client.embed(\n` +
        `    model=${JSON.stringify(model.modelId)},\n` +
        `    input_type='search_document',\n` +
        `    embedding_types=['float'],\n` +
        `    texts=['probe'],\n` +
        `)\n` +
        `print('cohere ok, dim:', len(r.embeddings.float[0]))\n`,
    ],
    { echo: true },
  );

  log.ok(`Cohere ${model.modelId} ready (API key validated)`);
}

export interface InstallEmbedModelOptions {
  /** Force redownload / revalidate. */
  force?: boolean;
  /** Resolved model picked by the user. */
  model: EmbedModel;
}

export async function installEmbedModel(opts: InstallEmbedModelOptions): Promise<void> {
  switch (opts.model.provider) {
    case 'local-minilm':
      await installMiniLM(!!opts.force);
      return;
    case 'cohere':
      await installCohere(opts.model);
      return;
    default:
      throw new Error(`Unsupported provider: ${(opts.model as EmbedModel).provider}`);
  }
}
