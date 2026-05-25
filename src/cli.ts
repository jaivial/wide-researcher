// wide-researcher CLI entry point.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { runInit } from './commands/init.js';
import { runAdd } from './commands/add.js';
import { runNeo4jSetup } from './commands/neo4j-setup.js';
import { runNeo4jSync } from './commands/neo4j-sync.js';
import { runReindex } from './commands/reindex.js';
import { runStatus } from './commands/status.js';
import { runSearch } from './commands/search.js';
import { runSymbolIndex } from './commands/symbol-index.js';
import { runUninstall } from './commands/uninstall.js';
import { runUpdate } from './commands/update.js';
import { log } from './utils/log.js';

// Resolve version from the package.json shipped with this build so the
// CLI never lies about its own release (the prior hardcoded string drifted
// behind every alpha bump).
const PKG_VERSION = (() => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(path.resolve(here, '..', 'package.json'), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const program = new Command();

program
  .name('wide-researcher')
  .description(
    'Qdrant-backed semantic code-search, AST/symbol graph search, and impact-radius diagrams for Claude Code.',
  )
  .version(PKG_VERSION);

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
  .option('--embed-provider <provider>', 'Skip interactive picker. Values: local-minilm | local-bge-large | local-gte-qwen2 | cohere')
  .option('--cohere-api-key <key>', 'Non-interactive Cohere key (use with --embed-provider cohere)')
  .action(
    async (opts: {
      force?: boolean;
      watch?: boolean;
      supervisor?: boolean;
      reindex?: boolean;
      embedProvider?: 'local-minilm' | 'local-bge-large' | 'local-gte-qwen2' | 'cohere';
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
  .command('backups')
  .description('List Qdrant collection backups for the current project.')
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts: { json?: boolean }) => {
    try {
      const { listBackups } = await import('./utils/qdrant-snapshot.js');
      const { deriveProjectIdentity } = await import('./installers/claude-bundle.js');
      const id = deriveProjectIdentity();
      const list = await listBackups(id.slug);
      if (opts.json) {
        process.stdout.write(JSON.stringify(list, null, 2) + '\n');
        return;
      }
      if (list.length === 0) {
        process.stdout.write(`(no backups for ${id.slug})\n`);
        return;
      }
      process.stdout.write(`Backups for ${id.slug}:\n`);
      for (const b of list) {
        process.stdout.write(`  ${b.timestamp}  provider=${b.provider}\n    ${b.absPath}\n`);
      }
    } catch (e) {
      fail(e);
    }
  });

program
  .command('add')
  .description('Add wide-researcher to a project on a machine that already has the global infra.')
  .option('--force', 'Re-run every step even if already healthy')
  .option('--no-watch', 'Skip the systemd/launchd watcher daemon')
  .option('--no-supervisor', 'Skip systemd/launchd registration entirely')
  .option('--no-reindex', 'Skip the initial reindex')
  .option('--embed-provider <provider>', 'Skip interactive picker. Values: local-minilm | local-bge-large | local-gte-qwen2 | cohere')
  .option('--cohere-api-key <key>', 'Non-interactive Cohere key')
  .action(
    async (opts: {
      force?: boolean;
      watch?: boolean;
      supervisor?: boolean;
      reindex?: boolean;
      embedProvider?: 'local-minilm' | 'local-bge-large' | 'local-gte-qwen2' | 'cohere';
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
  .command('symbol-index')
  .description('Payload-only AST/symbol graph update for existing code chunks; optional graph-node embeddings.')
  .option('--force', 'Recompute symbol payloads for all supported TS/TSX/C# files')
  .option('--max-files <n>', 'Process at most N changed files')
  .option('--with-node-embeddings', 'Create/update the symbol graph-node Qdrant collection')
  .option('--no-node-embeddings', 'Only update payloads on existing code chunks')
  .action(async (opts: { force?: boolean; maxFiles?: string; withNodeEmbeddings?: boolean; nodeEmbeddings?: boolean }) => {
    try {
      const maxFiles = opts.maxFiles ? parseInt(opts.maxFiles, 10) : undefined;
      await runSymbolIndex({
        force: opts.force,
        maxFiles: Number.isFinite(maxFiles) ? maxFiles : undefined,
        nodeEmbeddings: opts.withNodeEmbeddings === true,
      });
    } catch (e) {
      fail(e);
    }
  });

program
  .command('neo4j-sync')
  .description('Sync Qdrant symbol payloads into optional Neo4j graph backend.')
  .option('--max-files <n>', 'Process at most N files')
  .action(async (opts: { maxFiles?: string }) => {
    try {
      const maxFiles = opts.maxFiles ? parseInt(opts.maxFiles, 10) : undefined;
      await runNeo4jSync({ maxFiles: Number.isFinite(maxFiles) ? maxFiles : undefined });
    } catch (e) {
      fail(e);
    }
  });

program
  .command('neo4j-setup')
  .description('Auto-detect, install, and configure Neo4j for graph backend. Sets up credentials in config.json and .mcp.json.')
  .option('--non-interactive', 'Skip prompts; use existing config or fail')
  .action(async (opts: { nonInteractive?: boolean }) => {
    try {
      await runNeo4jSetup({ nonInteractive: !!opts.nonInteractive });
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
  .command('update')
  .description(
    "Refresh the per-project bundle after `npm i -g wide-researcher@latest`. " +
      "Preserves config, secrets, and the existing Qdrant collection — only " +
      "rewrites .claude/ skill files, the .mcp.json stanza, the prompt hook, " +
      "the supervisor unit, and (by default) the Python venv deps.",
  )
  .option('--no-pip-upgrade', 'Skip the `pip install -U -r requirements.txt` step')
  .option('--no-restart', 'Skip restarting the systemd/launchd indexer service')
  .option('--no-supervisor', 'Skip rewriting the supervisor unit')
  .action(async (opts: { pipUpgrade?: boolean; restart?: boolean; supervisor?: boolean }) => {
    try {
      await runUpdate({
        noPipUpgrade: opts.pipUpgrade === false,
        noRestart: opts.restart === false,
        noSupervisor: opts.supervisor === false,
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
