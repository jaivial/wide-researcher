// Central path resolver for wide-researcher.
//
// Two scopes:
//   • global  — `~/.wide-researcher/` (one per machine)
//   • project — `<cwd>/.wide-researcher/` (one per project)
//
// Every installer + command imports from here; never hard-code paths
// anywhere else.

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ── global (per machine) ───────────────────────────────────────────── */

export function globalRoot(): string {
  return path.join(os.homedir(), '.wide-researcher');
}

export function qdrantRoot(): string {
  return path.join(globalRoot(), 'qdrant');
}

export function qdrantBinary(): string {
  return path.join(qdrantRoot(), 'qdrant');
}

export function qdrantConfigPath(): string {
  return path.join(qdrantRoot(), 'config.yaml');
}

export function qdrantStorageRoot(): string {
  return path.join(qdrantRoot(), 'storage');
}

export function modelsRoot(): string {
  return path.join(globalRoot(), 'models');
}

export function miniLMPath(): string {
  return path.join(modelsRoot(), 'all-MiniLM-L6-v2');
}

export function venvRoot(): string {
  return path.join(globalRoot(), 'venv');
}

export function venvPython(): string {
  return path.join(venvRoot(), 'bin', 'python');
}

export function venvPip(): string {
  return path.join(venvRoot(), 'bin', 'pip');
}

export function pyPackageRoot(): string {
  // bundled python tree shipped with the npm package
  // (resolves relative to the compiled JS in dist/)
  return path.resolve(__dirname, '..', '..', 'python');
}

export function logsRoot(): string {
  return path.join(globalRoot(), 'logs');
}

/* ── project (per cwd) ──────────────────────────────────────────────── */

export function projectRoot(cwd: string = process.cwd()): string {
  return cwd;
}

export function projectConfigDir(cwd: string = process.cwd()): string {
  return path.join(cwd, '.wide-researcher');
}

export function projectConfigPath(cwd: string = process.cwd()): string {
  return path.join(projectConfigDir(cwd), 'config.json');
}

export function projectClaudeDir(cwd: string = process.cwd()): string {
  return path.join(cwd, '.claude');
}

export function projectMcpPath(cwd: string = process.cwd()): string {
  return path.join(cwd, '.mcp.json');
}

/* ── helpers ────────────────────────────────────────────────────────── */

export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
