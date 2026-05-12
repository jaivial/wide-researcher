// `wide-researcher reindex` — force a full reindex of the current project.

import { deriveProjectIdentity } from '../installers/claude-bundle.js';
import { run } from '../utils/exec.js';
import { exists, pyPackageRoot, venvPython } from '../utils/paths.js';
import { log } from '../utils/log.js';

export interface ReindexOptions {
  cwd?: string;
  /** Skip the hash check; re-embed every file regardless. */
  force?: boolean;
}

export async function runReindex(opts: ReindexOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const id = deriveProjectIdentity(cwd);

  if (!(await exists(id.configPath))) {
    throw new Error(
      `No wide-researcher config at ${id.configPath}.\n` +
        `  Run \`wide-researcher add\` (or \`init\` on a fresh machine) first.`,
    );
  }

  log.step(`reindex ${id.projectName} (slug=${id.slug})`);
  const args = ['-m', 'indexer', opts.force ? 'reindex' : 'incremental'];
  if (opts.force) args.push('--force');
  await run(venvPython(), args, {
    cwd: pyPackageRoot(),
    env: {
      ...process.env,
      WIDE_RESEARCHER_PROJECT_CONFIG: id.configPath,
    },
    echo: true,
  });
  log.ok('reindex complete');
}
