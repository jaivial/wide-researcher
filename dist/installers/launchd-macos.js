// launchd LaunchAgent installer for macOS.
//
// • Renders qdrant.plist from the template
// • Drops it at ~/Library/LaunchAgents/com.wide-researcher.qdrant.plist
// • `launchctl bootstrap gui/$UID <plist>` loads it
// • `launchctl kickstart -k gui/$UID/com.wide-researcher.qdrant` (re)starts
// • Polls qdrant /healthz until ready (5s timeout)
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../utils/exec.js';
import { log } from '../utils/log.js';
import { renderTemplate } from '../utils/template.js';
import { ensureDir, exists, logsRoot, pyPackageRoot, qdrantBinary, qdrantConfigPath, qdrantRoot, templatesRoot, venvPython, } from '../utils/paths.js';
const LABEL = 'com.wide-researcher.qdrant';
function launchAgentsDir() {
    return path.join(os.homedir(), 'Library', 'LaunchAgents');
}
function plistPath() {
    return path.join(launchAgentsDir(), `${LABEL}.plist`);
}
function guiDomain() {
    const uid = os.userInfo().uid;
    return `gui/${uid}`;
}
async function pollHealthz(maxMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
        try {
            const res = await fetch('http://127.0.0.1:6333/healthz', { method: 'GET' });
            if (res.ok)
                return true;
        }
        catch {
            // not ready
        }
        await new Promise((r) => setTimeout(r, 300));
    }
    return false;
}
export async function installQdrantServiceMacOS(opts = {}) {
    await ensureDir(launchAgentsDir());
    await ensureDir(logsRoot());
    const tplPath = path.join(templatesRoot(), 'launchd', 'qdrant.plist.tpl');
    const rendered = await renderTemplate(tplPath, {
        QDRANT_BIN: qdrantBinary(),
        QDRANT_CONFIG: qdrantConfigPath(),
        QDRANT_ROOT: qdrantRoot(),
        LOG_DIR: logsRoot(),
    });
    const existed = await exists(plistPath());
    let alreadyMatches = false;
    if (!opts.force && existed) {
        const cur = await fs.readFile(plistPath(), 'utf8');
        alreadyMatches = cur === rendered;
    }
    if (alreadyMatches) {
        log.skip(`launchd plist already present at ${plistPath()}`);
    }
    else {
        log.step(`writing ${plistPath()}`);
        await fs.writeFile(plistPath(), rendered, 'utf8');
    }
    // bootout first if we're replacing, then bootstrap
    if (existed && !alreadyMatches) {
        try {
            await run('launchctl', ['bootout', guiDomain(), plistPath()]);
        }
        catch {
            // not loaded — fine
        }
    }
    try {
        await run('launchctl', ['bootstrap', guiDomain(), plistPath()]);
    }
    catch (e) {
        // Already loaded? launchctl returns non-zero. Verify via the next kickstart.
        log.warn(`launchctl bootstrap returned non-zero (already loaded?): ${e.message}`);
    }
    try {
        await run('launchctl', ['kickstart', '-k', `${guiDomain()}/${LABEL}`]);
    }
    catch (e) {
        log.warn(`launchctl kickstart failed: ${e.message}`);
    }
    log.step('waiting for qdrant /healthz');
    const healthy = await pollHealthz(8000);
    if (!healthy) {
        throw new Error(`qdrant did not respond on http://127.0.0.1:6333/healthz within 8s.\n` +
            `  Inspect: tail ${path.join(logsRoot(), 'qdrant.log')}\n` +
            `  Or:      launchctl print ${guiDomain()}/${LABEL}`);
    }
    log.ok(`${LABEL} running on http://127.0.0.1:6333`);
}
export async function uninstallQdrantServiceMacOS() {
    if (await exists(plistPath())) {
        try {
            await run('launchctl', ['bootout', guiDomain(), plistPath()]);
        }
        catch {
            // ignore
        }
        await fs.rm(plistPath(), { force: true });
    }
}
function indexerLabel(slug) {
    return `com.wide-researcher.indexer.${slug}`;
}
function indexerPlistPath(slug) {
    return path.join(launchAgentsDir(), `${indexerLabel(slug)}.plist`);
}
export async function installIndexerServiceMacOS(opts) {
    await ensureDir(launchAgentsDir());
    await ensureDir(logsRoot());
    const tplPath = path.join(templatesRoot(), 'launchd', 'indexer.plist.tpl');
    const rendered = await renderTemplate(tplPath, {
        PROJECT_NAME: opts.projectName,
        PROJECT_SLUG: opts.slug,
        PROJECT_CONFIG: opts.projectConfigPath,
        VENV_PYTHON: venvPython(),
        PY_ROOT: pyPackageRoot(),
        LOG_DIR: logsRoot(),
    });
    const ppath = indexerPlistPath(opts.slug);
    const existed = await exists(ppath);
    let alreadyMatches = false;
    if (!opts.force && existed) {
        const cur = await fs.readFile(ppath, 'utf8');
        alreadyMatches = cur === rendered;
    }
    if (alreadyMatches) {
        log.skip(`indexer plist already present at ${ppath}`);
    }
    else {
        log.step(`writing ${ppath}`);
        await fs.writeFile(ppath, rendered, 'utf8');
    }
    if (existed && !alreadyMatches) {
        try {
            await run('launchctl', ['bootout', guiDomain(), ppath]);
        }
        catch {
            // ignore
        }
    }
    try {
        await run('launchctl', ['bootstrap', guiDomain(), ppath]);
    }
    catch (e) {
        log.warn(`launchctl bootstrap returned non-zero (already loaded?): ${e.message}`);
    }
    try {
        await run('launchctl', ['kickstart', '-k', `${guiDomain()}/${indexerLabel(opts.slug)}`]);
    }
    catch (e) {
        log.warn(`launchctl kickstart failed: ${e.message}`);
    }
    log.ok(`indexer watcher running for project=${opts.slug}`);
}
export async function uninstallIndexerServiceMacOS(slug) {
    const ppath = indexerPlistPath(slug);
    if (await exists(ppath)) {
        try {
            await run('launchctl', ['bootout', guiDomain(), ppath]);
        }
        catch {
            // ignore
        }
        await fs.rm(ppath, { force: true });
    }
}
//# sourceMappingURL=launchd-macos.js.map