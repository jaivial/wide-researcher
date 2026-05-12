// OS / arch detection for picking the right Qdrant binary.

import os from 'node:os';

export type SupportedOs = 'linux' | 'macos';
export type SupportedArch = 'x86_64' | 'aarch64';

export interface PlatformInfo {
  os: SupportedOs;
  arch: SupportedArch;
  /** Qdrant release asset target triple, e.g. `x86_64-unknown-linux-gnu`. */
  qdrantTriple: string;
}

export function detectPlatform(): PlatformInfo {
  const platform = process.platform;
  const arch = process.arch;

  let osKey: SupportedOs;
  if (platform === 'linux') {
    osKey = 'linux';
  } else if (platform === 'darwin') {
    osKey = 'macos';
  } else if (platform === 'win32') {
    throw new Error(
      'Native Windows is not supported in v0.1. Run wide-researcher inside WSL2 instead.',
    );
  } else {
    throw new Error(`Unsupported platform: ${platform}. Linux + macOS only in v0.1.`);
  }

  let archKey: SupportedArch;
  if (arch === 'x64') {
    archKey = 'x86_64';
  } else if (arch === 'arm64') {
    archKey = 'aarch64';
  } else {
    throw new Error(`Unsupported CPU architecture: ${arch}. x86_64 + arm64 only.`);
  }

  // Qdrant publishes release artifacts named, e.g.:
  //   qdrant-x86_64-unknown-linux-gnu.tar.gz
  //   qdrant-aarch64-unknown-linux-gnu.tar.gz
  //   qdrant-x86_64-apple-darwin.tar.gz
  //   qdrant-aarch64-apple-darwin.tar.gz
  const triple =
    osKey === 'linux'
      ? `${archKey}-unknown-linux-gnu`
      : `${archKey}-apple-darwin`;

  return { os: osKey, arch: archKey, qdrantTriple: triple };
}

export function hasSystemd(): boolean {
  return process.platform === 'linux';
}

export function hasLaunchd(): boolean {
  return process.platform === 'darwin';
}

export function cpuCount(): number {
  return os.cpus().length;
}
