// Platform dispatcher for process supervision (qdrant + per-project indexer).

import { hasLaunchd, hasSystemd } from '../utils/platform.js';
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

/* ── qdrant (machine-wide singleton) ───────────────────────────────── */

export async function installQdrantSupervisor(opts: SupervisorOptions = {}): Promise<void> {
  if (hasSystemd()) return installQdrantServiceLinux(opts);
  if (hasLaunchd()) return installQdrantServiceMacOS(opts);
  throw new Error('Unsupported platform for supervisor: need systemd (Linux) or launchd (macOS).');
}

export async function uninstallQdrantSupervisor(): Promise<void> {
  if (hasSystemd()) return uninstallQdrantServiceLinux();
  if (hasLaunchd()) return uninstallQdrantServiceMacOS();
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
  throw new Error('Unsupported platform for indexer supervisor: need systemd or launchd.');
}

export async function uninstallIndexerSupervisor(slug: string): Promise<void> {
  if (hasSystemd()) return uninstallIndexerServiceLinux(slug);
  if (hasLaunchd()) return uninstallIndexerServiceMacOS(slug);
}
