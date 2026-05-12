// wide-researcher CLI entry point.
//
// Phase 1 (this commit) wires the command names + help text but every
// command body is a stub that prints "not yet implemented". The bodies
// land in Phase 8 once Phases 2-7 (indexer, installers, supervisor,
// watcher, MCP server, Claude bundle) are merged.

import { Command } from 'commander';
import chalk from 'chalk';

const program = new Command();

program
  .name('wide-researcher')
  .description(
    'Qdrant-backed semantic code-search + impact-radius diagrams for Claude Code.',
  )
  .version('0.1.0-alpha.0');

program
  .command('init')
  .description('First-time setup on this machine: install Qdrant + embed model + indexer for the current project.')
  .option('--no-watch', 'Skip systemd/launchd watcher daemon install (auto-watch is ON by default)')
  .option('--qdrant-port <port>', 'Qdrant REST port (default 6333; auto-fallback to 6334 on conflict)', '6333')
  .action(() => {
    stubCommand('init');
  });

program
  .command('add')
  .description('Add wide-researcher to a new project (skip global install — Qdrant + model assumed present).')
  .option('--no-watch', 'Skip watcher daemon install for this project')
  .action(() => {
    stubCommand('add');
  });

program
  .command('reindex')
  .description('Force a full reindex of the current project.')
  .action(() => {
    stubCommand('reindex');
  });

program
  .command('status')
  .description('Show Qdrant health, indexer state, and last-index timestamp for the current project.')
  .action(() => {
    stubCommand('status');
  });

program
  .command('search <query>')
  .description('Terminal-side smoke search against the current project collection.')
  .option('-m, --mode <mode>', 'search mode: semantic | keyword | hybrid', 'hybrid')
  .option('-k, --top-k <n>', 'number of results', '10')
  .action(() => {
    stubCommand('search');
  });

program
  .command('uninstall')
  .description('Remove wide-researcher from the current project. Use --all to also nuke ~/.wide-researcher/.')
  .option('--all', 'Also remove global install (Qdrant, model, venv, systemd units)')
  .action(() => {
    stubCommand('uninstall');
  });

program.parse();

function stubCommand(name: string): never {
  console.error(
    `${chalk.yellow('[wide-researcher]')} '${name}' is not implemented yet — ` +
    `this is Phase 1 (skeleton). See the roadmap in README.md.`,
  );
  process.exit(64);
}
