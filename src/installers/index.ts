// Aggregate export so commands can `import { installAll } from '../installers/index.js'`.

export { installQdrant, QDRANT_VERSION } from './qdrant.js';
export { installPythonVenv } from './python-venv.js';
export { installEmbedModel, EMBED_MODEL_ID } from './embed-model.js';

import { installQdrant } from './qdrant.js';
import { installPythonVenv } from './python-venv.js';
import { installEmbedModel } from './embed-model.js';

export interface InstallAllOptions {
  force?: boolean;
}

/**
 * Install ALL global infrastructure that the `init` command needs.
 * Ordered deliberately:
 *   1. Python venv first (the embed-model installer runs inside it).
 *   2. Embed model (depends on venv).
 *   3. Qdrant binary (independent; cheapest to verify).
 */
export async function installGlobalInfra(opts: InstallAllOptions = {}): Promise<void> {
  await installPythonVenv(opts);
  await installEmbedModel(opts);
  await installQdrant(opts);
}
