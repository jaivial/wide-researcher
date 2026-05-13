// `wide-researcher init` — first-time setup on this machine.
//
// Steps (each idempotent):
//   0. Pick embed model (interactive — 4 options)
//   1. Install global infra (qdrant + venv + embed model + supervisor)
//   2. Derive project identity → write `<project>/.wide-researcher/config.json`
//   3. Install Claude bundle (.claude/ + .mcp.json + hook)
//   4. Bootstrap the Qdrant collection (HNSW + payload indexes)
//   5. Run the initial reindex
//   6. Register the per-project indexer watcher daemon (unless --no-watch)
import { deriveProjectIdentity, installClaudeBundle, installGlobalInfra, installIndexerSupervisor, pickEmbedModel, } from '../installers/index.js';
import { run } from '../utils/exec.js';
import { log } from '../utils/log.js';
import { pyPackageRoot, venvPython } from '../utils/paths.js';
import { cleanStaleNpxCache } from '../utils/npx-cache.js';
export async function runInit(opts = {}) {
    const cwd = opts.cwd ?? process.cwd();
    // Clean stale npx caches from prior versions. npx caches packages under
    // ~/.npm/_npx/<hash>/node_modules/wide-researcher/ and doesn't
    // auto-evict old versions. When a user upgrades via `npx wide-researcher@latest`,
    // the new version's JS runs but the old Python code may linger in a different
    // cache slot. We nuke any cached version older than the current one.
    cleanStaleNpxCache();
    log.step('0/6 · embed model selection');
    const pick = await pickEmbedModel({
        forceProvider: opts.embedProvider,
        apiKey: opts.cohereApiKey,
        cwd,
    });
    const model = pick.model;
    log.info(`chosen: ${model.label} (provider=${model.provider}, dim=${model.embedDim})`);
    if (pick.oldCollectionBackup) {
        log.info(`old collection backed up at: ${pick.oldCollectionBackup}`);
    }
    if (pick.restoreFromBackup) {
        log.info(`will restore from previous backup: ${pick.restoreFromBackup}`);
    }
    if (!opts.onlyProject) {
        log.step('1/6 · global infra (qdrant + python venv + embed model + supervisor)');
        await installGlobalInfra({ force: opts.force, noSupervisor: opts.noSupervisor, model });
    }
    else {
        log.skip('1/6 · global infra (skipped — already installed)');
    }
    log.step('2/6 · project identity + config.json');
    const id = deriveProjectIdentity(cwd);
    log.info(`project=${id.projectName} slug=${id.slug}`);
    log.step('3/6 · claude bundle (agent + skill + .mcp.json + hook)');
    await installClaudeBundle({ cwd, force: opts.force, model });
    // Phase 4 + 5 branch on whether we're restoring a backup.
    if (pick.restoreFromBackup) {
        log.step('4-5/6 · restoring qdrant collection from backup (skips reindex)');
        const { restoreFromSnapshot } = await import('../utils/qdrant-snapshot.js');
        await restoreFromSnapshot(id.slug, pick.restoreFromBackup);
        log.ok('collection restored from backup — no reindex needed.');
    }
    else {
        log.step('4/6 · bootstrap qdrant collection');
        await run(venvPython(), ['-m', 'scripts.init_collection'], {
            cwd: pyPackageRoot(),
            env: {
                ...process.env,
                WIDE_RESEARCHER_PROJECT_CONFIG: id.configPath,
            },
            echo: true,
        });
        if (opts.noReindex) {
            log.skip('5/6 · initial reindex (skipped via --no-reindex)');
        }
        else {
            log.step('5/6 · initial reindex (this takes a minute or two)');
            await run(venvPython(), ['-m', 'indexer', 'reindex', '--force'], {
                cwd: pyPackageRoot(),
                env: {
                    ...process.env,
                    WIDE_RESEARCHER_PROJECT_CONFIG: id.configPath,
                },
                echo: true,
            });
        }
    }
    if (opts.noWatch || opts.noSupervisor) {
        log.skip('6/6 · indexer watcher (skipped via --no-watch / --no-supervisor)');
    }
    else {
        log.step('6/6 · register indexer watcher daemon');
        await installIndexerSupervisor({
            slug: id.slug,
            projectName: id.projectName,
            projectConfigPath: id.configPath,
            force: opts.force,
        });
    }
    log.ok(`wide-researcher ready in ${id.projectName} (embed: ${model.label})`);
    log.info('open Claude Code in this directory — wr_find / wr_impact / wr_file are auto-discovered.');
}
//# sourceMappingURL=init.js.map