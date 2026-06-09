// `wide-researcher update` — refresh per-project artefacts after a global
// npm upgrade without touching the user's data or configuration.
//
// Workflow for a user on an older alpha:
//   1. `npm install -g wide-researcher@latest`     (global JS + Python)
//   2. `wide-researcher update`                    (refresh project bundle)
//
// What we refresh (force-rewrite from the templates that ship with the new
// package version):
//   • .claude/agents/wide-researcher.md
//   • .claude/skills/wide-research/**          (SKILL.md + references/)
//   • .claude/settings.local.json              (only the UserPromptSubmit
//                                               hook entry; other entries
//                                               are preserved)
//   • .wide-researcher/hooks/wide_research_hook.py
//   • .mcp.json `wide-researcher` server stanza  (other servers untouched)
//   • systemd/launchd indexer unit             (paths to bundled bin may
//                                               have changed)
//   • Python venv deps                          (pip install -U -r reqs)
//
// What we DO NOT touch:
//   • ~/.wide-researcher/qdrant/storage/        (the index — keep it!)
//   • ~/.wide-researcher/secrets.json           (Cohere / Neo4j keys)
//   • <project>/.wide-researcher/config.json    (embed-provider choice;
//                                                only updated if the
//                                                stored provider differs
//                                                from the active one)
//   • .wide-researcher/.file_index.json         (incremental sidecar)
//
// We do NOT re-run the initial reindex — the collection schema is
// unchanged across alpha versions.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { deriveProjectIdentity, installClaudeBundle, installIndexerSupervisor, } from '../installers/index.js';
import { modelById } from '../models/registry.js';
import { run } from '../utils/exec.js';
import { exists, pyPackageRoot, venvPip, venvPython, venvRoot } from '../utils/paths.js';
import { hasLaunchd, hasSystemd } from '../utils/platform.js';
import { log } from '../utils/log.js';
import { cleanStaleNpxCache } from '../utils/npx-cache.js';
async function readPersistedConfig(configPath) {
    if (!(await exists(configPath)))
        return null;
    try {
        const raw = await fs.readFile(configPath, 'utf8');
        return JSON.parse(raw);
    }
    catch (e) {
        throw new Error(`existing project config at ${configPath} is not valid JSON: ${e.message}`);
    }
}
async function pipUpgrade() {
    if (!(await exists(venvPython()))) {
        log.warn(`python venv missing at ${venvRoot()} — run 'wide-researcher init' instead of 'update' on this machine.`);
        return;
    }
    const requirements = path.join(pyPackageRoot(), 'requirements.txt');
    if (!(await exists(requirements))) {
        log.warn(`requirements.txt missing at ${requirements} — skipping pip upgrade`);
        return;
    }
    log.step('refreshing python dependencies (pip install -U -r requirements.txt)');
    await run(venvPip(), ['install', '--upgrade', '-r', requirements], { echo: true });
}
async function restartIndexerService(slug) {
    if (hasSystemd()) {
        const unit = `wide-researcher-indexer-${slug}.service`;
        try {
            await run('systemctl', ['--user', 'restart', unit], { echo: false });
            log.ok(`restarted systemd unit ${unit}`);
        }
        catch (e) {
            // Common cases: unit not registered (containers, --no-supervisor),
            // or systemctl --user unavailable (no user session, headless server).
            // Both are benign — log and move on.
            log.warn(`could not restart ${unit}: ${e.message}`);
        }
        return;
    }
    if (hasLaunchd()) {
        const label = `com.wide-researcher.indexer.${slug}`;
        try {
            await run('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? ''}/${label}`], {
                echo: false,
            });
            log.ok(`kickstarted launchd job ${label}`);
        }
        catch (e) {
            log.warn(`could not kickstart ${label}: ${e.message}`);
        }
        return;
    }
    log.skip('no supervisor on this platform — restart watcher manually if running');
}
export async function runUpdate(opts = {}) {
    const cwd = opts.cwd ?? process.cwd();
    log.step('0/4 · clean stale npx caches');
    await cleanStaleNpxCache();
    const id = deriveProjectIdentity(cwd);
    log.info(`project=${id.projectName} slug=${id.slug}`);
    const persisted = await readPersistedConfig(id.configPath);
    if (!persisted) {
        throw new Error(`no project config found at ${id.configPath}. ` +
            `Run 'wide-researcher init' on this project first; 'update' is only ` +
            `for projects that have been initialised at least once.`);
    }
    const providerKey = persisted.embed_provider;
    if (!providerKey) {
        throw new Error(`project config ${id.configPath} is missing 'embed_provider'. ` +
            `Re-run 'wide-researcher init' to repair.`);
    }
    const model = modelById(providerKey);
    log.info(`keeping existing embed model: ${model.label} (provider=${model.provider}, dim=${model.embedDim})`);
    if (!opts.noPipUpgrade) {
        log.step('1/5 · python deps');
        await pipUpgrade();
    }
    else {
        log.skip('1/5 · python deps (skipped via --no-pip-upgrade)');
    }
    log.step('2/5 · refresh claude bundle (.claude/ + .mcp.json + hook)');
    // force=true so SKILL.md / agent.md / hook script are rewritten from the
    // new templates. keepProjectConfig=true preserves user-customised fields
    // in <project>/.wide-researcher/config.json (excludes, batch_size, etc).
    await installClaudeBundle({ cwd, force: true, model, keepProjectConfig: true });
    if (opts.noSupervisor) {
        log.skip('3/5 · supervisor unit (skipped via --no-supervisor)');
    }
    else {
        log.step('3/5 · refresh indexer supervisor unit');
        await installIndexerSupervisor({
            slug: id.slug,
            projectName: id.projectName,
            projectConfigPath: id.configPath,
            force: true,
        });
    }
    if (opts.noRestart || opts.noSupervisor) {
        log.skip('4/5 · restart watcher service (skipped)');
    }
    else {
        log.step('4/5 · restart watcher service');
        await restartIndexerService(id.slug);
    }
    // Step 5: refresh the skills collection. Idempotent; cheap when no
    // files have changed.
    log.step('5/5 · refresh skills collection (SKILL.md / agents / references)');
    await run(venvPython(), ['-m', 'scripts.init_skills_collection'], {
        cwd: pyPackageRoot(),
        env: { ...process.env, WIDE_RESEARCHER_PROJECT_CONFIG: id.configPath },
        echo: true,
    });
    await run(venvPython(), ['-m', 'scripts.skills_index', '--prune'], {
        cwd: pyPackageRoot(),
        env: { ...process.env, WIDE_RESEARCHER_PROJECT_CONFIG: id.configPath },
        echo: true,
    });
    log.ok(`wide-researcher updated in ${id.projectName}.`);
    log.info('Index data, secrets, and embed-provider choice were preserved.');
    log.info('Reopen Claude Code in this directory so it spawns a fresh MCP server with the new code.');
}
//# sourceMappingURL=update.js.map