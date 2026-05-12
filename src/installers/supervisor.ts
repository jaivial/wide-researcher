// Platform dispatcher for qdrant process supervision.

import { hasLaunchd, hasSystemd } from '../utils/platform.js';
import {
  installQdrantServiceLinux,
  uninstallQdrantServiceLinux,
} from './systemd-linux.js';
import {
  installQdrantServiceMacOS,
  uninstallQdrantServiceMacOS,
} from './launchd-macos.js';

export interface SupervisorOptions {
  force?: boolean;
}

export async function installQdrantSupervisor(opts: SupervisorOptions = {}): Promise<void> {
  if (hasSystemd()) {
    return installQdrantServiceLinux(opts);
  }
  if (hasLaunchd()) {
    return installQdrantServiceMacOS(opts);
  }
  throw new Error('Unsupported platform for supervisor: need systemd (Linux) or launchd (macOS).');
}

export async function uninstallQdrantSupervisor(): Promise<void> {
  if (hasSystemd()) {
    return uninstallQdrantServiceLinux();
  }
  if (hasLaunchd()) {
    return uninstallQdrantServiceMacOS();
  }
}
