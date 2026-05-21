import { readFileSync, writeFileSync } from 'node:fs';

import neo4j from 'neo4j-driver';

import { runNeo4jSync } from './neo4j-sync.js';
import { deriveProjectIdentity, writeMcpStanza } from '../installers/claude-bundle.js';
import { loadProjectConfig } from '../mcp-server/config.js';
import { run, which } from '../utils/exec.js';
import { log } from '../utils/log.js';
import { ask, askSecret } from '../utils/prompt.js';

export interface Neo4jSetupOptions {
  cwd?: string;
  nonInteractive?: boolean;
}

function installHelp(): string {
  if (process.platform === 'linux') return 'Install Neo4j: sudo apt-get update && sudo apt-get install -y neo4j';
  if (process.platform === 'darwin') return 'Install Neo4j: brew install neo4j';
  return 'Install Neo4j: https://neo4j.com/download/';
}

async function isServiceActive(): Promise<boolean> {
  if (process.platform !== 'linux') return true;
  try {
    const result = await run('systemctl', ['is-active', 'neo4j'], { capture: true });
    return result.stdout.trim() === 'active';
  } catch {
    return false;
  }
}

async function canConnect(uri: string, username: string, password: string): Promise<boolean> {
  const driver = neo4j.driver(uri, neo4j.auth.basic(username, password));
  try {
    await driver.getServerInfo();
    return true;
  } catch {
    return false;
  } finally {
    await driver.close();
  }
}

export async function runNeo4jSetup(opts: Neo4jSetupOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const id = deriveProjectIdentity(cwd);
  process.argv.push('--project-config', id.configPath);
  const cfg = loadProjectConfig();

  if (cfg.graphProvider !== 'neo4j') {
    log.skip('graph_provider is not neo4j; neo4j-setup not needed.');
    return;
  }

  const neo4jBin = await which('neo4j');
  if (!neo4jBin) {
    log.warn('Neo4j does not appear to be installed.');
    log.info(installHelp());
    return;
  }

  const serviceActive = await isServiceActive();
  if (!serviceActive) {
    log.warn('Neo4j is installed but service is not active.');
    if (process.platform === 'linux') {
      log.info('Start with: sudo systemctl start neo4j');
    } else {
      log.info('Start your Neo4j service, then re-run wide-researcher neo4j-setup');
    }
    return;
  }

  let uri = process.env[cfg.neo4j.uriEnv] || cfg.neo4j.uri || 'bolt://127.0.0.1:7687';
  let user = process.env[cfg.neo4j.userEnv] || cfg.neo4j.user || 'neo4j';
  let password = process.env[cfg.neo4j.passwordEnv] || cfg.neo4j.password || '';
  const database = process.env[cfg.neo4j.databaseEnv] || cfg.neo4j.database || 'neo4j';

  if (opts.nonInteractive && (!uri || !user || !password)) {
    throw new Error('Missing Neo4j credentials in non-interactive mode. Set env vars or config.json neo4j fields.');
  }

  let connected = uri && user && password ? await canConnect(uri, user, password) : false;
  while (!connected) {
    if (opts.nonInteractive) {
      throw new Error('Neo4j connection failed in non-interactive mode.');
    }
    log.warn('Neo4j connection failed. Please re-enter credentials.');
    uri = await ask('Neo4j Bolt URI: ', uri || 'bolt://127.0.0.1:7687');
    user = await ask('Neo4j username: ', user || 'neo4j');
    password = await askSecret('Neo4j password: ');
    connected = await canConnect(uri, user, password);
  }

  if (cfg.neo4j.uri === uri && cfg.neo4j.user === user && cfg.neo4j.password === password && cfg.neo4j.database === database) {
    log.ok('Neo4j already configured.');
  } else {
    const doc = JSON.parse(readFileSync(id.configPath, 'utf8')) as Record<string, unknown>;
    const neo4jCfg = (doc.neo4j && typeof doc.neo4j === 'object' ? doc.neo4j : {}) as Record<string, unknown>;
    neo4jCfg.uri = uri;
    neo4jCfg.user = user;
    neo4jCfg.password = password;
    neo4jCfg.database = database;
    doc.neo4j = neo4jCfg;
    writeFileSync(id.configPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    log.ok(`updated ${id.configPath} with neo4j credentials`);
  }

  await writeMcpStanza(id, true);
  await runNeo4jSync({ cwd });
}
