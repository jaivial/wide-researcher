// wide-researcher CLI entry point.

import { Command } from 'commander';

import { runInit } from './commands/init.js';
import { runAdd } from './commands/add.js';
import { runReindex } from './commands/reindex.js';
import { runStatus } from './commands/status.js';
import { runSearch } from './commands/search.js';
import { runUninstall } from './commands/uninstall.js';
import { log } from './utils/log.js';

const program = new Command();

program
  .name('wide-researcher')
  .description(
    'Qdrant-backed semantic code-search + impact-radius diagrams for Claude Code.',
  )
  .version('0.1.0-alpha.0');

function fail(e: unknown): never {
  log.error((e as Error).message);
  process.exit(1);
}

program
  .command('init')
  .description(
    'First-time setup on this machine: install Qdrant + embed model + indexer for the current project.',
  )
  .option('--force', 'Re-run every step even if already healthy')
  .option('--no-watch', 'Skip the systemd/launchd watcher daemon (auto-watch is ON by default)')
  .option('--no-supervisor', 'Skip systemd/launchd registration entirely (containers / CI)')
  .option('--no-reindex', 'Skip the initial reindex (useful for smoke tests)')
  .option('--embed-provider <provider>', 'Skip interactive picker. Values: local-minilm | cohere')
  .option('--cohere-api-key <key>', 'Non-interactive Cohere key (use with --embed-provider cohere)')
  .action(
    async (opts: {
      force?: boolean;
      watch?: boolean;
      supervisor?: boolean;
      reindex?: boolean;
      embedProvider?: 'local-minilm' | 'cohere';
      cohereApiKey?: string;
    }) => {
      try {
        await runInit({
          force: opts.force,
          // commander turns `--no-foo` into `foo: false`
          noWatch: opts.watch === false,
          noSupervisor: opts.supervisor === false,
          noReindex: opts.reindex === false,
          embedProvider: opts.embedProvider,
          cohereApiKey: opts.cohereApiKey,
        });
      } catch (e) {
        fail(e);
      }
    },
  );

program
  .command('add')
  .description('Add wide-researcher to a project on a machine that already has the global infra.')
  .option('--force', 'Re-run every step even if already healthy')
  .option('--no-watch', 'Skip the systemd/launchd watcher daemon')
  .option('--no-supervisor', 'Skip systemd/launchd registration entirely')
  .option('--no-reindex', 'Skip the initial reindex')
  .option('--embed-provider <provider>', 'Skip interactive picker. Values: local-minilm | cohere')
  .option('--cohere-api-key <key>', 'Non-interactive Cohere key')
  .action(
    async (opts: {
      force?: boolean;
      watch?: boolean;
      supervisor?: boolean;
      reindex?: boolean;
      embedProvider?: 'local-minilm' | 'cohere';
      cohereApiKey?: string;
    }) => {
      try {
        await runAdd({
          force: opts.force,
          noWatch: opts.watch === false,
          noSupervisor: opts.supervisor === false,
          noReindex: opts.reindex === false,
          embedProvider: opts.embedProvider,
          cohereApiKey: opts.cohereApiKey,
        });
      } catch (e) {
        fail(e);
      }
    },
  );

program
  .command('reindex')
  .description('Reindex the current project. Default = incremental; --force = full rebuild.')
  .option('--force', 'Skip the hash check; re-embed every file regardless.')
  .action(async (opts: { force?: boolean }) => {
    try {
      await runReindex({ force: opts.force });
    } catch (e) {
      fail(e);
    }
  });

program
  .command('status')
  .description('Show Qdrant health, indexer state, and last-index timestamp for the current project.')
  .option('--json', 'Emit machine-readable JSON instead of the table view.')
  .action(async (opts: { json?: boolean }) => {
    try {
      await runStatus({ json: opts.json });
    } catch (e) {
      fail(e);
    }
  });

program
  .command('search <query>')
  .description('Terminal-side smoke search against the current project collection.')
  .option('-m, --mode <mode>', 'search mode: semantic | keyword | hybrid (default: semantic in v0.1)', 'semantic')
  .option('-k, --top-k <n>', 'number of results', '10')
  .action(async (query: string, opts: { mode?: 'semantic' | 'keyword' | 'hybrid'; topK?: string }) => {
    try {
      await runSearch(query, {
        mode: opts.mode ?? 'semantic',
        topK: opts.topK ? parseInt(opts.topK, 10) : 10,
      });
    } catch (e) {
      fail(e);
    }
  });

program
  .command('uninstall')
  .description('Remove wide-researcher from the current project. Use --all to also nuke ~/.wide-researcher/.')
  .option('--all', 'Also remove global install (qdrant, model, venv, systemd units)')
  .option('--drop-collection', 'Also drop the Qdrant collection (default: keep it for reinstall reuse)')
  .action(async (opts: { all?: boolean; dropCollection?: boolean }) => {
    try {
      await runUninstall({ all: opts.all, dropCollection: opts.dropCollection });
    } catch (e) {
      fail(e);
    }
  });

program.parse();
