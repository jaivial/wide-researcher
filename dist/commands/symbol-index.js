import { deriveProjectIdentity } from '../installers/claude-bundle.js';
import { run } from '../utils/exec.js';
import { log } from '../utils/log.js';
import { exists, pyPackageRoot, venvPython } from '../utils/paths.js';
export async function runSymbolIndex(opts = {}) {
    const cwd = opts.cwd ?? process.cwd();
    const id = deriveProjectIdentity(cwd);
    if (!(await exists(id.configPath))) {
        throw new Error(`No wide-researcher config at ${id.configPath}.\n` +
            '  Run `wide-researcher add` (or `init` on a fresh machine) first.');
    }
    const args = ['-m', 'scripts.symbol_index'];
    if (opts.force)
        args.push('--force');
    if (opts.maxFiles && opts.maxFiles > 0)
        args.push('--max-files', String(opts.maxFiles));
    args.push(opts.nodeEmbeddings ? '--with-node-embeddings' : '--no-node-embeddings');
    log.step(`symbol-index ${id.projectName} (slug=${id.slug})`);
    await run(venvPython(), args, {
        cwd: pyPackageRoot(),
        env: {
            ...process.env,
            WIDE_RESEARCHER_PROJECT_CONFIG: id.configPath,
        },
        echo: true,
    });
    log.ok('symbol-index complete');
}
//# sourceMappingURL=symbol-index.js.map