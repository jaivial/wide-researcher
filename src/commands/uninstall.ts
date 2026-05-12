// `wide-researcher uninstall` — surgical removal.
//
// • Default: remove only the per-project bits (Claude bundle, .mcp.json
//   stanza, .wide-researcher/ config dir) + the project's indexer
//   watcher service.
// • `--all`: also nuke `~/.wide-researcher/` (qdrant binary, model,
//   venv, logs) and the global qdrant supervisor.
//
// We DO NOT drop the Qdrant collection by default — the collection
// is cheap to keep around and lets the user reinstall later without
// re-indexing. Pass `--drop-collection` to also drop it.

import { promises as fs } from 'node:fs';

import {
  deriveProjectIdentity,
  uninstallClaudeBundle,
  uninstallIndexerSupervisor,
  uninstallQdrantSupervisor,
} from '../installers/index.js';
import { run } from '../utils/exec.js';
import { exists, globalRoot, venvPython } from '../utils/paths.js';
import { log } from '../utils/log.js';
import { pyPackageRoot } from '../utils/paths.js';

export interface UninstallOptions {
  cwd?: string;
  all?: boolean;
  dropCollection?: boolean;
}

export async function runUninstall(opts: UninstallOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const id = deriveProjectIdentity(cwd);

  log.step(`uninstalling wide-researcher from ${id.projectName}`);

  // 1. Stop + unregister the indexer watcher for this project.
  await uninstallIndexerSupervisor(id.slug);
  log.ok('indexer watcher removed');

  // 2. Optionally drop the Qdrant collection (keep by default — cheap to
  //    keep around so reinstall doesn't re-index).
  if (opts.dropCollection && (await exists(id.configPath))) {
    try {
      await run(
        venvPython(),
        ['-c',
         'from indexer.config import QDRANT_COLLECTION; ' +
         'from qdrant_client import QdrantClient; ' +
         'from indexer.config import QDRANT_URL; ' +
         'QdrantClient(url=QDRANT_URL).delete_collection(QDRANT_COLLECTION); ' +
         'print("dropped:", QDRANT_COLLECTION)'],
        {
          cwd: pyPackageRoot(),
          env: {
            ...process.env,
            WIDE_RESEARCHER_PROJECT_CONFIG: id.configPath,
          },
          echo: true,
        },
      );
    } catch (e) {
      log.warn(`drop-collection failed (collection may already be gone): ${(e as Error).message}`);
    }
  }

  // 3. Remove the Claude bundle (.claude/, .mcp.json stanza,
  //    .wide-researcher/ config dir).
  await uninstallClaudeBundle({ cwd });
  log.ok('per-project files removed');

  // 4. Optional --all: nuke global infra.
  if (opts.all) {
    log.step('removing global infrastructure (--all)');
    await uninstallQdrantSupervisor();
    log.ok('qdrant supervisor removed');
    if (await exists(globalRoot())) {
      await fs.rm(globalRoot(), { recursive: true, force: true });
      log.ok(`removed ${globalRoot()}`);
    }
  } else {
    log.info(`global infra preserved at ${globalRoot()} (use --all to nuke it)`);
  }
}
