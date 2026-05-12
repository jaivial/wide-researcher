// Secure storage for API keys at `~/.wide-researcher/secrets.json`.
//
// File is created with mode 600 (owner read/write only). Directory
// is mode 700. On Windows the chmod is best-effort; NTFS ACL is the
// real protection (inherits from the parent user dir).

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { ensureDir, exists, globalRoot } from './paths.js';

function secretsPath(): string {
  return path.join(globalRoot(), 'secrets.json');
}

export interface Secrets {
  cohere_api_key?: string;
  // future: openai_api_key, voyage_api_key, etc.
}

async function readAll(): Promise<Secrets> {
  if (!(await exists(secretsPath()))) return {};
  try {
    const raw = await fs.readFile(secretsPath(), 'utf8');
    const doc = JSON.parse(raw) as Secrets;
    return doc ?? {};
  } catch {
    return {};
  }
}

async function writeAll(doc: Secrets): Promise<void> {
  await ensureDir(globalRoot());
  // Tighten dir mode (no-op on Windows)
  try {
    await fs.chmod(globalRoot(), 0o700);
  } catch {
    /* ignore */
  }
  await fs.writeFile(secretsPath(), JSON.stringify(doc, null, 2) + '\n', 'utf8');
  try {
    await fs.chmod(secretsPath(), 0o600);
  } catch {
    /* ignore — Windows */
  }
}

export async function getSecret(key: keyof Secrets): Promise<string | undefined> {
  const doc = await readAll();
  return doc[key];
}

export async function setSecret(key: keyof Secrets, value: string): Promise<void> {
  const doc = await readAll();
  doc[key] = value;
  await writeAll(doc);
}

export async function deleteSecret(key: keyof Secrets): Promise<void> {
  const doc = await readAll();
  delete doc[key];
  await writeAll(doc);
}

export function secretsFilePath(): string {
  return secretsPath();
}
