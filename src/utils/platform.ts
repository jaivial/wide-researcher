// OS / arch detection for picking the right Qdrant binary.

import os from 'node:os';

export type SupportedOs = 'linux' | 'macos' | 'windows';
export type SupportedArch = 'x86_64' | 'aarch64';

export interface PlatformInfo {
  os: SupportedOs;
  arch: SupportedArch;
  /** Qdrant release asset target triple, e.g. `x86_64-unknown-linux-gnu`. */
  qdrantTriple: string;
  /** Qdrant release archive extension (`tar.gz` on POSIX, `zip` on Windows). */
  qdrantArchiveExt: 'tar.gz' | 'zip';
  /** Whether `process.platform === 'win32'`. */
  isWindows: boolean;
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
    osKey = 'windows';
  } else {
    throw new Error(`Unsupported platform: ${platform}. Linux / macOS / Windows only.`);
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
  //   qdrant-x86_64-pc-windows-msvc.zip       (Windows only — no aarch64)
  let triple: string;
  let ext: 'tar.gz' | 'zip';
  if (osKey === 'linux') {
    triple = `${archKey}-unknown-linux-gnu`;
    ext = 'tar.gz';
  } else if (osKey === 'macos') {
    triple = `${archKey}-apple-darwin`;
    ext = 'tar.gz';
  } else {
    // windows
    if (archKey !== 'x86_64') {
      throw new Error(
        `Qdrant does not ship ${archKey} Windows binaries (only x86_64). ` +
          `If you are on Windows ARM, run inside WSL2 to use the linux/aarch64 build.`,
      );
    }
    triple = `${archKey}-pc-windows-msvc`;
    ext = 'zip';
  }

  return {
    os: osKey,
    arch: archKey,
    qdrantTriple: triple,
    qdrantArchiveExt: ext,
    isWindows: osKey === 'windows',
  };
}

export function hasSystemd(): boolean {
  return process.platform === 'linux';
}

export function hasLaunchd(): boolean {
  return process.platform === 'darwin';
}

export function isWindows(): boolean {
  return process.platform === 'win32';
}

export function cpuCount(): number {
  return os.cpus().length;
}
