// `wide-researcher search "<query>"` — terminal-side smoke search.
// Spawns `python -m indexer search-debug "<query>"` against the
// project's config so the user can sanity-check the index without
// going through Claude.
import { deriveProjectIdentity } from '../installers/claude-bundle.js';
import { run } from '../utils/exec.js';
import { exists, pyPackageRoot, venvPython } from '../utils/paths.js';
export async function runSearch(query, opts = {}) {
    const cwd = opts.cwd ?? process.cwd();
    const id = deriveProjectIdentity(cwd);
    if (!(await exists(id.configPath))) {
        throw new Error(`No wide-researcher config at ${id.configPath}.\n` +
            `  Run \`wide-researcher add\` (or \`init\` on a fresh machine) first.`);
    }
    // The indexer's `search-debug` subcommand is semantic-only; for
    // keyword/hybrid the user should call Claude (or pipe through the
    // MCP server). v0.1 ships a single CLI search mode.
    await run(venvPython(), ['-m', 'indexer', 'search-debug', query], {
        cwd: pyPackageRoot(),
        env: {
            ...process.env,
            WIDE_RESEARCHER_PROJECT_CONFIG: id.configPath,
        },
        echo: true,
    });
}
//# sourceMappingURL=search.js.map