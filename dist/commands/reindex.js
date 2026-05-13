// `wide-researcher reindex` — force a full reindex of the current project.
import { readFileSync } from 'node:fs';
import { deriveProjectIdentity } from '../installers/claude-bundle.js';
import { run } from '../utils/exec.js';
import { exists, pyPackageRoot, venvPython } from '../utils/paths.js';
import { log } from '../utils/log.js';
export async function runReindex(opts = {}) {
    const cwd = opts.cwd ?? process.cwd();
    const id = deriveProjectIdentity(cwd);
    if (!(await exists(id.configPath))) {
        throw new Error(`No wide-researcher config at ${id.configPath}.\n` +
            `  Run \`wide-researcher add\` (or \`init\` on a fresh machine) first.`);
    }
    // Detect embed provider from config to route Cohere to bulk_reindex
    // (subprocess-per-file) which prevents httpx/pydantic memory leaks.
    let useBulkReindex = false;
    try {
        const cfg = JSON.parse(readFileSync(id.configPath, 'utf8'));
        if (cfg.embed_provider === 'cohere') {
            useBulkReindex = true;
        }
    }
    catch {
        // Can't read config — use standard reindex
    }
    if (useBulkReindex && opts.force) {
        log.step(`reindex ${id.projectName} (slug=${id.slug}) — subprocess-per-file (Cohere)`);
        await run(venvPython(), ['-m', 'scripts.bulk_reindex', '--force'], {
            cwd: pyPackageRoot(),
            env: {
                ...process.env,
                WIDE_RESEARCHER_PROJECT_CONFIG: id.configPath,
            },
            echo: true,
        });
    }
    else if (useBulkReindex) {
        log.step(`reindex ${id.projectName} (slug=${id.slug}) — subprocess-per-file (Cohere)`);
        await run(venvPython(), ['-m', 'scripts.bulk_reindex'], {
            cwd: pyPackageRoot(),
            env: {
                ...process.env,
                WIDE_RESEARCHER_PROJECT_CONFIG: id.configPath,
            },
            echo: true,
        });
    }
    else {
        log.step(`reindex ${id.projectName} (slug=${id.slug})`);
        const args = ['-m', 'indexer', opts.force ? 'reindex' : 'incremental'];
        if (opts.force)
            args.push('--force');
        await run(venvPython(), args, {
            cwd: pyPackageRoot(),
            env: {
                ...process.env,
                WIDE_RESEARCHER_PROJECT_CONFIG: id.configPath,
            },
            echo: true,
        });
    }
    log.ok('reindex complete');
}
//# sourceMappingURL=reindex.js.map