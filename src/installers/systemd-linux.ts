// systemd --user unit installer for Linux.
//
// • Renders qdrant.service from the template
// • Drops it at ~/.config/systemd/user/qdrant.service
// • Runs daemon-reload + enable --now
// • Polls qdrant /healthz until ready (5s timeout)
//
// Idempotent — re-runs cleanly. If `systemctl --user` is unavailable
// (rare in containers / CI), throws a clear error pointing at the
// foreground fallback in INSTALL.md.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { run } from '../utils/exec.js';
import { log } from '../utils/log.js';
import { renderTemplate } from '../utils/template.js';
import {
  ensureDir,
  exists,
  logsRoot,
  pyPackageRoot,
  qdrantBinary,
  qdrantConfigPath,
  qdrantRoot,
  templatesRoot,
  venvPython,
} from '../utils/paths.js';

const UNIT_NAME = 'qdrant.service';

function systemdUserDir(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user');
}

function unitPath(): string {
  return path.join(systemdUserDir(), UNIT_NAME);
}

async function systemctlAvailable(): Promise<boolean> {
  try {
    await run('systemctl', ['--user', '--version'], { capture: true });
    return true;
  } catch {
    return false;
  }
}

async function pollHealthz(maxMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch('http://127.0.0.1:6333/healthz', { method: 'GET' });
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

export interface InstallQdrantServiceOptions {
  /** Re-render + reload + restart even if the unit is already present. */
  force?: boolean;
}

export async function installQdrantServiceLinux(
  opts: InstallQdrantServiceOptions = {},
): Promise<void> {
  if (!(await systemctlAvailable())) {
    throw new Error(
      'systemctl --user is not available on this host.\n' +
        '  Most container / CI environments disable user-scope systemd.\n' +
        '  Falls-back to the foreground daemon listed in docs/INSTALL.md.',
    );
  }

  await ensureDir(systemdUserDir());
  await ensureDir(logsRoot());

  const tplPath = path.join(templatesRoot(), 'systemd', 'qdrant.service.tpl');
  const rendered = await renderTemplate(tplPath, {
    QDRANT_BIN: qdrantBinary(),
    QDRANT_CONFIG: qdrantConfigPath(),
    QDRANT_ROOT: qdrantRoot(),
    LOG_DIR: logsRoot(),
  });

  let alreadyMatches = false;
  if (!opts.force && (await exists(unitPath()))) {
    const existing = await fs.readFile(unitPath(), 'utf8');
    alreadyMatches = existing === rendered;
  }

  if (alreadyMatches) {
    log.skip(`systemd unit already present at ${unitPath()}`);
  } else {
    log.step(`writing ${unitPath()}`);
    await fs.writeFile(unitPath(), rendered, 'utf8');
    await run('systemctl', ['--user', 'daemon-reload']);
  }

  log.step(`enabling + starting ${UNIT_NAME}`);
  // `enable --now` is idempotent on systemd ≥ 230.
  await run('systemctl', ['--user', 'enable', '--now', UNIT_NAME]);

  // restart if force OR we just wrote a new file (so changes apply)
  if (!alreadyMatches && opts.force !== undefined) {
    await run('systemctl', ['--user', 'restart', UNIT_NAME]);
  }

  log.step('waiting for qdrant /healthz');
  const healthy = await pollHealthz(8000);
  if (!healthy) {
    throw new Error(
      `qdrant did not respond on http://127.0.0.1:6333/healthz within 8s.\n` +
        `  Inspect:  journalctl --user -u qdrant.service -n 100\n` +
        `  Or log:   tail ${path.join(logsRoot(), 'qdrant.log')}`,
    );
  }
  log.ok('qdrant.service running on http://127.0.0.1:6333');
}

export async function uninstallQdrantServiceLinux(): Promise<void> {
  try {
    await run('systemctl', ['--user', 'disable', '--now', UNIT_NAME]);
  } catch {
    // not enabled — ignore
  }
  if (await exists(unitPath())) {
    await fs.rm(unitPath(), { force: true });
  }
  try {
    await run('systemctl', ['--user', 'daemon-reload']);
  } catch {
    // ignore
  }
}

/* ── per-project indexer (watcher daemon) ──────────────────────────── */

export interface InstallIndexerServiceOptions {
  /** Stable slug for the project (filename-safe). */
  slug: string;
  /** Human-readable project name (cosmetic — goes in Description=). */
  projectName: string;
  /** Absolute path to the project's `.wide-researcher/config.json`. */
  projectConfigPath: string;
  force?: boolean;
}

function indexerUnitName(slug: string): string {
  return `wide-researcher-indexer-${slug}.service`;
}

function indexerUnitPath(slug: string): string {
  return path.join(systemdUserDir(), indexerUnitName(slug));
}

export async function installIndexerServiceLinux(
  opts: InstallIndexerServiceOptions,
): Promise<void> {
  if (!(await systemctlAvailable())) {
    throw new Error('systemctl --user not available — cannot register indexer watcher.');
  }

  await ensureDir(systemdUserDir());
  await ensureDir(logsRoot());

  const tplPath = path.join(templatesRoot(), 'systemd', 'wide-researcher-indexer.service.tpl');
  const rendered = await renderTemplate(tplPath, {
    PROJECT_NAME: opts.projectName,
    PROJECT_SLUG: opts.slug,
    PROJECT_CONFIG: opts.projectConfigPath,
    VENV_PYTHON: venvPython(),
    PY_ROOT: pyPackageRoot(),
    LOG_DIR: logsRoot(),
  });

  const upath = indexerUnitPath(opts.slug);
  let alreadyMatches = false;
  if (!opts.force && (await exists(upath))) {
    const existing = await fs.readFile(upath, 'utf8');
    alreadyMatches = existing === rendered;
  }

  if (alreadyMatches) {
    log.skip(`indexer unit already present at ${upath}`);
  } else {
    log.step(`writing ${upath}`);
    await fs.writeFile(upath, rendered, 'utf8');
    await run('systemctl', ['--user', 'daemon-reload']);
  }

  log.step(`enabling + starting ${indexerUnitName(opts.slug)}`);
  await run('systemctl', ['--user', 'enable', '--now', indexerUnitName(opts.slug)]);

  if (!alreadyMatches && opts.force !== undefined) {
    await run('systemctl', ['--user', 'restart', indexerUnitName(opts.slug)]);
  }

  log.ok(`indexer watcher running for project=${opts.slug}`);
}

export async function uninstallIndexerServiceLinux(slug: string): Promise<void> {
  try {
    await run('systemctl', ['--user', 'disable', '--now', indexerUnitName(slug)]);
  } catch {
    // ignore
  }
  if (await exists(indexerUnitPath(slug))) {
    await fs.rm(indexerUnitPath(slug), { force: true });
  }
  try {
    await run('systemctl', ['--user', 'daemon-reload']);
  } catch {
    // ignore
  }
}
