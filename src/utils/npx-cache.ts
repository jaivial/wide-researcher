// Clean stale npx caches of wide-researcher.
//
// npx stores each resolved version under
//   ~/.npm/_npx/<hash>/node_modules/wide-researcher/
// and does NOT evict old versions when a new one is fetched.
// This means running `npx wide-researcher@0.1.0-alpha.9` may still have
// the alpha.0 Python code sitting in a sibling cache directory that the
// subprocess (spawned from the npm package) might accidentally import.
//
// This module scans all npx cache slots for wide-researcher and removes
// any whose version is older than the current one.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from './log.js';

// Read version from the package.json sitting next to this compiled file.
const CURRENT_VERSION = (() => {
  try {
    const pkgPath = path.resolve(import.meta.dirname, '..', '..', 'package.json');
    const raw = JSON.parse(fsSync.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return raw.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// Simple semver comparison (handles pre-release tags like alpha.N).
function parseSemver(v: string): [number, number, number, number] {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-alpha\.(\d+))?/);
  if (!m) return [0, 0, 0, 0];
  return [+m[1]!, +m[2]!, +m[3]!, +(m[4] ?? 0)];
}

function semverGt(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 4; i++) {
    if (pa[i]! > pb[i]!) return true;
    if (pa[i]! < pb[i]!) return false;
  }
  return false;
}

export async function cleanStaleNpxCache(): Promise<void> {
  const npxRoot = path.join(os.homedir(), '.npm', '_npx');
  let entries: string[];
  try {
    entries = await fs.readdir(npxRoot);
  } catch {
    return; // no npx cache at all — fresh machine
  }

  let cleaned = 0;
  for (const hash of entries) {
    const pkgJsonPath = path.join(
      npxRoot, hash, 'node_modules', 'wide-researcher', 'package.json',
    );
    try {
      const raw = await fs.readFile(pkgJsonPath, 'utf8');
      const pkg = JSON.parse(raw) as { version?: string };
      if (pkg.version && semverGt(CURRENT_VERSION, pkg.version)) {
        const slotDir = path.join(npxRoot, hash);
        await fs.rm(slotDir, { recursive: true, force: true });
        log.info(`cleaned stale npx cache: ${pkg.version} (${hash})`);
        cleaned++;
      }
    } catch {
      // Not a wide-researcher cache slot — skip
    }
  }
  if (cleaned > 0) {
    log.ok(`cleaned ${cleaned} stale npx cache(s) (current: ${CURRENT_VERSION})`);
  }
}
