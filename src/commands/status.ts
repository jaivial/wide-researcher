// `wide-researcher status` — qdrant health + indexer state + last-index time.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';

import { deriveProjectIdentity } from '../installers/claude-bundle.js';
import { hasLaunchd, hasSystemd, isWindows } from '../utils/platform.js';
import { run } from '../utils/exec.js';
import {
  exists,
  logsRoot,
  projectConfigDir,
  qdrantBinary,
} from '../utils/paths.js';

export interface StatusOptions {
  cwd?: string;
  json?: boolean;
}

interface StatusReport {
  project: {
    name: string;
    slug: string;
    root: string;
    configPath: string;
    installed: boolean;
  };
  global: {
    qdrantBinary: boolean;
  };
  qdrant: {
    reachable: boolean;
    url: string;
    collection: string;
    pointsCount?: number;
    vectorSize?: number;
    statusColor?: string;
  };
  indexer: {
    serviceState: string;
    lastIndex: string | null;
  };
}

async function qdrantHealthz(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/healthz`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

async function qdrantCollectionInfo(
  url: string,
  collection: string,
): Promise<{ pointsCount?: number; vectorSize?: number; statusColor?: string }> {
  try {
    const res = await fetch(`${url}/collections/${collection}`);
    if (!res.ok) return {};
    const body = (await res.json()) as {
      result?: {
        points_count?: number;
        status?: string;
        config?: { params?: { vectors?: { size?: number } } };
      };
    };
    return {
      pointsCount: body.result?.points_count,
      vectorSize: body.result?.config?.params?.vectors?.size,
      statusColor: body.result?.status,
    };
  } catch {
    return {};
  }
}

async function indexerServiceState(slug: string): Promise<string> {
  if (hasSystemd()) {
    try {
      const r = await run(
        'systemctl',
        ['--user', 'is-active', `wide-researcher-indexer-${slug}.service`],
        { capture: true },
      );
      return r.stdout.trim();
    } catch (e) {
      const out = (e as { result?: { stdout?: string } }).result?.stdout?.trim();
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
    } catch {
      return 'not loaded';
    }
  }
  if (isWindows()) {
    return 'manual (no Windows supervisor in v0.1)';
  }
  return 'unsupported platform';
}

async function lastIndexTimestamp(cwd: string): Promise<string | null> {
  const sidecar = path.join(projectConfigDir(cwd), '.file_index.json');
  if (!(await exists(sidecar))) return null;
  try {
    const stat = await fs.stat(sidecar);
    return stat.mtime.toISOString();
  } catch {
    return null;
  }
}

export async function runStatus(opts: StatusOptions = {}): Promise<StatusReport> {
  const cwd = opts.cwd ?? process.cwd();
  const id = deriveProjectIdentity(cwd);
  const installed = await exists(id.configPath);

  // Load qdrant_url from project config when available; fall back to default.
  let qdrantUrl = 'http://127.0.0.1:6333';
  if (installed) {
    try {
      const raw = await fs.readFile(id.configPath, 'utf8');
      const cfg = JSON.parse(raw) as { qdrant_url?: string };
      qdrantUrl = cfg.qdrant_url ?? qdrantUrl;
    } catch {
      // ignore — stick with default
    }
  }

  const [hasQdrantBin, reachable, lastIndex] = await Promise.all([
    exists(qdrantBinary()),
    qdrantHealthz(qdrantUrl),
    lastIndexTimestamp(cwd),
  ]);
  const colInfo = reachable
    ? await qdrantCollectionInfo(qdrantUrl, id.slug)
    : {};
  const indexerState = await indexerServiceState(id.slug);

  const report: StatusReport = {
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
      collection: id.slug,
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

  const tick = (ok: boolean): string => (ok ? chalk.green('✓') : chalk.red('✗'));
  const pad = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - s.length));

  process.stdout.write([
    `${chalk.bold('project')}     ${pad(id.projectName, 24)} slug=${id.slug}`,
    `${chalk.bold('installed')}   ${tick(installed)}  ${id.configPath}`,
    `${chalk.bold('qdrant bin')}  ${tick(hasQdrantBin)}  ${qdrantBinary()}`,
    `${chalk.bold('qdrant svc')}  ${tick(reachable)}  ${qdrantUrl}`,
    `${chalk.bold('collection')}  ${pad(id.slug, 24)}`,
    `  points    ${colInfo.pointsCount ?? '?'}`,
    `  vector    ${colInfo.vectorSize ?? '?'}-d ${colInfo.statusColor ? `(${colInfo.statusColor})` : ''}`,
    `${chalk.bold('indexer')}     ${indexerState}`,
    `${chalk.bold('last index')}  ${lastIndex ?? '(never)'}`,
    `${chalk.bold('logs')}        ${path.join(logsRoot(), `indexer-${id.slug}.log`)}`,
  ].join('\n') + '\n');

  return report;
}
