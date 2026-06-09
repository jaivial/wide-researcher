// Wide-researcher skills collection management.
//
// Walks <project>/.claude/skills + ~/.claude/skills (and agents/*.md) and
// upserts every SKILL.md / references/*.md / agents/*.md into the
// `<collection>_skills` Qdrant collection. Idempotent on re-run.

import { deriveProjectIdentity } from '../installers/claude-bundle.js';
import { run } from '../utils/exec.js';
import { log } from '../utils/log.js';
import { exists, pyPackageRoot, venvPython } from '../utils/paths.js';

export interface SkillsIndexOptions {
  cwd?: string;
  force?: boolean;
  dryRun?: boolean;
  prune?: boolean;
  initCollection?: boolean;
}

export async function runSkillsInitCollection(cwd: string = process.cwd()): Promise<void> {
  const id = deriveProjectIdentity(cwd);
  if (!(await exists(id.configPath))) {
    throw new Error(
      `No wide-researcher config at ${id.configPath}.\n` +
        '  Run `wide-researcher add` (or `init` on a fresh machine) first.',
    );
  }
  log.step('init skills collection');
  await run(venvPython(), ['-m', 'scripts.init_skills_collection'], {
    cwd: pyPackageRoot(),
    env: { ...process.env, WIDE_RESEARCHER_PROJECT_CONFIG: id.configPath },
    echo: true,
  });
  log.ok('skills collection ready');
}

export async function runSkillsIndex(opts: SkillsIndexOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const id = deriveProjectIdentity(cwd);
  if (!(await exists(id.configPath))) {
    throw new Error(
      `No wide-researcher config at ${id.configPath}.\n` +
        '  Run `wide-researcher add` (or `init` on a fresh machine) first.',
    );
  }

  if (opts.initCollection) {
    await runSkillsInitCollection(cwd);
  }

  const args = ['-m', 'scripts.skills_index'];
  if (opts.force) args.push('--force');
  if (opts.dryRun) args.push('--dry-run');
  if (opts.prune) args.push('--prune');

  log.step(`skills-index ${id.projectName} (slug=${id.slug})`);
  await run(venvPython(), args, {
    cwd: pyPackageRoot(),
    env: { ...process.env, WIDE_RESEARCHER_PROJECT_CONFIG: id.configPath },
    echo: true,
  });
  log.ok('skills-index complete');
}
