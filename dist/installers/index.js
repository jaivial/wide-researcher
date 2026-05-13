// Aggregate export so commands can `import { installAll } from '../installers/index.js'`.
export { installQdrant, QDRANT_VERSION } from './qdrant.js';
export { installPythonVenv } from './python-venv.js';
export { installEmbedModel, EMBED_MODEL_ID } from './embed-model.js';
export { pickEmbedModel } from './embed-picker.js';
export { installQdrantSupervisor, uninstallQdrantSupervisor, installIndexerSupervisor, uninstallIndexerSupervisor, } from './supervisor.js';
export { installClaudeBundle, uninstallClaudeBundle, deriveProjectIdentity, } from './claude-bundle.js';
import { installQdrant } from './qdrant.js';
import { installPythonVenv } from './python-venv.js';
import { installEmbedModel } from './embed-model.js';
import { installQdrantSupervisor } from './supervisor.js';
/**
 * Install ALL global infrastructure that the `init` command needs.
 * Ordered deliberately:
 *   1. Python venv first (the embed-model installer runs inside it).
 *   2. Embed model (depends on venv) — local download OR API validate.
 *   3. Qdrant binary.
 *   4. Qdrant supervisor (systemd / launchd) — last, so it boots a
 *      qdrant that is guaranteed to exist on disk.
 */
export async function installGlobalInfra(opts) {
    await installPythonVenv({ force: opts.force });
    await installEmbedModel({ force: opts.force, model: opts.model });
    await installQdrant({ force: opts.force });
    if (opts.noSupervisor) {
        return;
    }
    await installQdrantSupervisor({ force: opts.force });
}
//# sourceMappingURL=index.js.map