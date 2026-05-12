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
import {
  ensureDir,
  exists,
  logsRoot,
  qdrantBinary,
  qdrantConfigPath,
  qdrantRoot,
  templatesRoot,
} from '../utils/paths.js';

const LABEL = 'com.wide-researcher.qdrant';

function launchAgentsDir(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents');
}

function plistPath(): string {
  return path.join(launchAgentsDir(), `${LABEL}.plist`);
}

function guiDomain(): string {
  const uid = os.userInfo().uid;
  return `gui/${uid}`;
}

async function pollHealthz(maxMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch('http://127.0.0.1:6333/healthz', { method: 'GET' });
      if (res.ok) return true;
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

export interface InstallQdrantServiceOptions {
  force?: boolean;
}

export async function installQdrantServiceMacOS(
  opts: InstallQdrantServiceOptions = {},
): Promise<void> {
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
  } else {
    log.step(`writing ${plistPath()}`);
    await fs.writeFile(plistPath(), rendered, 'utf8');
  }

  // bootout first if we're replacing, then bootstrap
  if (existed && !alreadyMatches) {
    try {
      await run('launchctl', ['bootout', guiDomain(), plistPath()]);
    } catch {
      // not loaded — fine
    }
  }

  try {
    await run('launchctl', ['bootstrap', guiDomain(), plistPath()]);
  } catch (e) {
    // Already loaded? launchctl returns non-zero. Verify via the next kickstart.
    log.warn(`launchctl bootstrap returned non-zero (already loaded?): ${(e as Error).message}`);
  }

  try {
    await run('launchctl', ['kickstart', '-k', `${guiDomain()}/${LABEL}`]);
  } catch (e) {
    log.warn(`launchctl kickstart failed: ${(e as Error).message}`);
  }

  log.step('waiting for qdrant /healthz');
  const healthy = await pollHealthz(8000);
  if (!healthy) {
    throw new Error(
      `qdrant did not respond on http://127.0.0.1:6333/healthz within 8s.\n` +
        `  Inspect: tail ${path.join(logsRoot(), 'qdrant.log')}\n` +
        `  Or:      launchctl print ${guiDomain()}/${LABEL}`,
    );
  }
  log.ok(`${LABEL} running on http://127.0.0.1:6333`);
}

export async function uninstallQdrantServiceMacOS(): Promise<void> {
  if (await exists(plistPath())) {
    try {
      await run('launchctl', ['bootout', guiDomain(), plistPath()]);
    } catch {
      // ignore
    }
    await fs.rm(plistPath(), { force: true });
  }
}
