// Platform dispatcher for process supervision (qdrant + per-project indexer).
//
// Windows note: there is no first-class user-scope process supervisor in
// the v0.1 install. We log a friendly warning + tell the user how to run
// the daemons manually (or under nssm / Task Scheduler). Hooking into
// Task Scheduler properly is roadmap for v0.2.

import { hasLaunchd, hasSystemd, isWindows } from '../utils/platform.js';
import { log } from '../utils/log.js';
import { pyPackageRoot, qdrantBinary, qdrantConfigPath, venvPython } from '../utils/paths.js';
import {
  installIndexerServiceLinux,
  installQdrantServiceLinux,
  uninstallIndexerServiceLinux,
  uninstallQdrantServiceLinux,
} from './systemd-linux.js';
import {
  installIndexerServiceMacOS,
  installQdrantServiceMacOS,
  uninstallIndexerServiceMacOS,
  uninstallQdrantServiceMacOS,
} from './launchd-macos.js';

export interface SupervisorOptions {
  force?: boolean;
}

function warnWindowsManual(): void {
  log.warn('Windows detected — no automatic supervisor in v0.1. Daemons must be started manually:');
  log.warn(`  qdrant:   "${qdrantBinary()}" --config-path "${qdrantConfigPath()}"`);
  log.warn(`  watcher:  set WIDE_RESEARCHER_PROJECT_CONFIG=<path>\\.wide-researcher\\config.json`);
  log.warn(`            cd "${pyPackageRoot()}" && "${venvPython()}" -m scripts.watcher --verbose`);
  log.warn('  Or wrap with nssm.exe / Task Scheduler. v0.2 will automate this.');
}

/* ── qdrant (machine-wide singleton) ───────────────────────────────── */

export async function installQdrantSupervisor(opts: SupervisorOptions = {}): Promise<void> {
  if (hasSystemd()) return installQdrantServiceLinux(opts);
  if (hasLaunchd()) return installQdrantServiceMacOS(opts);
  if (isWindows()) {
    warnWindowsManual();
    return;
  }
  throw new Error('Unsupported platform for supervisor: need systemd / launchd / Windows.');
}

export async function uninstallQdrantSupervisor(): Promise<void> {
  if (hasSystemd()) return uninstallQdrantServiceLinux();
  if (hasLaunchd()) return uninstallQdrantServiceMacOS();
  // Windows: nothing to uninstall (no supervisor was registered)
}

/* ── per-project indexer watcher ───────────────────────────────────── */

export interface IndexerSupervisorOptions extends SupervisorOptions {
  slug: string;
  projectName: string;
  projectConfigPath: string;
}

export async function installIndexerSupervisor(opts: IndexerSupervisorOptions): Promise<void> {
  if (hasSystemd()) return installIndexerServiceLinux(opts);
  if (hasLaunchd()) return installIndexerServiceMacOS(opts);
  if (isWindows()) {
    // Already warned by installQdrantSupervisor — stay quiet on the
    // per-project leg.
    return;
  }
  throw new Error('Unsupported platform for indexer supervisor.');
}

export async function uninstallIndexerSupervisor(slug: string): Promise<void> {
  if (hasSystemd()) return uninstallIndexerServiceLinux(slug);
  if (hasLaunchd()) return uninstallIndexerServiceMacOS(slug);
  // Windows: nothing to uninstall
  void slug;
}
