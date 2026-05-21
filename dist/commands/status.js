// `wide-researcher status` — qdrant health + indexer state + last-index time.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { deriveProjectIdentity } from '../installers/claude-bundle.js';
import { hasLaunchd, hasSystemd, isWindows } from '../utils/platform.js';
import { run } from '../utils/exec.js';
import { exists, logsRoot, projectConfigDir, qdrantBinary, } from '../utils/paths.js';
async function qdrantHealthz(url) {
    try {
        const res = await fetch(`${url}/healthz`, { method: 'GET' });
        return res.ok;
    }
    catch {
        return false;
    }
}
async function qdrantCollectionInfo(url, collection) {
    try {
        const res = await fetch(`${url}/collections/${collection}`);
        if (!res.ok)
            return {};
        const body = (await res.json());
        return {
            pointsCount: body.result?.points_count,
            vectorSize: body.result?.config?.params?.vectors?.size,
            statusColor: body.result?.status,
        };
    }
    catch {
        return {};
    }
}
async function indexerServiceState(slug) {
    if (hasSystemd()) {
        try {
            const r = await run('systemctl', ['--user', 'is-active', `wide-researcher-indexer-${slug}.service`], { capture: true });
            return r.stdout.trim();
        }
        catch (e) {
            const out = e.result?.stdout?.trim();
            return out || 'inactive';
        }
    }
    if (hasLaunchd()) {
        const label = `com.wide-researcher.indexer.${slug}`;
        try {
            await run('launchctl', ['print', `gui/${process.getuid?.()}/${label}`], {
                capture: true,
            });
            return 'loaded';
        }
        catch {
            return 'not loaded';
        }
    }
    if (isWindows()) {
        return 'manual (no Windows supervisor in v0.1)';
    }
    return 'unsupported platform';
}
async function lastIndexTimestamp(cwd) {
    const sidecar = path.join(projectConfigDir(cwd), '.file_index.json');
    if (!(await exists(sidecar)))
        return null;
    try {
        const stat = await fs.stat(sidecar);
        return stat.mtime.toISOString();
    }
    catch {
        return null;
    }
}
export async function runStatus(opts = {}) {
    const cwd = opts.cwd ?? process.cwd();
    const id = deriveProjectIdentity(cwd);
    const installed = await exists(id.configPath);
    let qdrantUrl = 'http://127.0.0.1:6333';
    let collectionName = id.slug;
    if (installed) {
        try {
            const raw = await fs.readFile(id.configPath, 'utf8');
            const cfg = JSON.parse(raw);
            qdrantUrl = cfg.qdrant_url ?? qdrantUrl;
            collectionName = cfg.collection_name ?? collectionName;
        }
        catch {
            // ignore — stick with defaults
        }
    }
    const [hasQdrantBin, reachable, lastIndex] = await Promise.all([
        exists(qdrantBinary()),
        qdrantHealthz(qdrantUrl),
        lastIndexTimestamp(cwd),
    ]);
    const colInfo = reachable
        ? await qdrantCollectionInfo(qdrantUrl, collectionName)
        : {};
    const indexerState = await indexerServiceState(id.slug);
    const report = {
        project: {
            name: id.projectName,
            slug: id.slug,
            root: id.projectRoot,
            configPath: id.configPath,
            installed,
        },
        global: {
            qdrantBinary: hasQdrantBin,
        },
        qdrant: {
            reachable,
            url: qdrantUrl,
            collection: collectionName,
            ...colInfo,
        },
        indexer: {
            serviceState: indexerState,
            lastIndex,
        },
    };
    if (opts.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        return report;
    }
    const tick = (ok) => (ok ? chalk.green('✓') : chalk.red('✗'));
    const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));
    process.stdout.write([
        `${chalk.bold('project')}     ${pad(id.projectName, 24)} slug=${id.slug}`,
        `${chalk.bold('installed')}   ${tick(installed)}  ${id.configPath}`,
        `${chalk.bold('qdrant bin')}  ${tick(hasQdrantBin)}  ${qdrantBinary()}`,
        `${chalk.bold('qdrant svc')}  ${tick(reachable)}  ${qdrantUrl}`,
        `${chalk.bold('collection')}  ${pad(collectionName, 24)}`,
        `  points    ${colInfo.pointsCount ?? '?'}`,
        `  vector    ${colInfo.vectorSize ?? '?'}-d ${colInfo.statusColor ? `(${colInfo.statusColor})` : ''}`,
        `${chalk.bold('indexer')}     ${indexerState}`,
        `${chalk.bold('last index')}  ${lastIndex ?? '(never)'}`,
        `${chalk.bold('logs')}        ${path.join(logsRoot(), `indexer-${id.slug}.log`)}`,
    ].join('\n') + '\n');
    return report;
}
//# sourceMappingURL=status.js.map