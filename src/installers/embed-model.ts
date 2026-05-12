// Embed-model installer.
//
// Pulls `sentence-transformers/all-MiniLM-L6-v2` (~80 MB) into
// `~/.wide-researcher/models/all-MiniLM-L6-v2/` via
// `huggingface_hub.snapshot_download`, run inside the wide-researcher
// venv so the dep is already there.
//
// Idempotent: skips download if the model dir exists AND can be loaded
// by `sentence_transformers.SentenceTransformer(...)`.

import { run } from '../utils/exec.js';
import { log } from '../utils/log.js';
import {
  ensureDir,
  exists,
  miniLMPath,
  modelsRoot,
  venvPython,
} from '../utils/paths.js';

export const EMBED_MODEL_ID = 'sentence-transformers/all-MiniLM-L6-v2';

async function modelIsHealthy(): Promise<boolean> {
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

export interface InstallEmbedModelOptions {
  /** Force redownload even if model is already on disk. */
  force?: boolean;
}

export async function installEmbedModel(opts: InstallEmbedModelOptions = {}): Promise<void> {
  await ensureDir(modelsRoot());

  if (!opts.force && (await modelIsHealthy())) {
    log.skip(`embed model already installed at ${miniLMPath()}`);
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

  if (!(await modelIsHealthy())) {
    throw new Error(
      `embed model downloaded but failed to load. Inspect ${miniLMPath()} and re-run with --force.`,
    );
  }

  log.ok(`embed model ready at ${miniLMPath()}`);
}
