// Project config loader for the MCP server. Reads from the JSON file
// supplied via `--project-config <path>` (or the
// `WIDE_RESEARCHER_PROJECT_CONFIG` env var if argv is omitted).
//
// The MCP server is spawned by Claude Code from `.mcp.json`, so argv
// is the canonical channel — env vars do not always propagate through
// the Claude harness.

import { readFileSync } from 'node:fs';

export interface Neo4jConfig {
  uriEnv: string;
  userEnv: string;
  passwordEnv: string;
  databaseEnv: string;
  uri?: string;
  user?: string;
  password?: string;
  database?: string;
}

export interface ProjectConfig {
  projectName: string;
  projectRoot: string;
  collectionName: string;
  qdrantUrl: string;
  embedProvider: string;
  embedModel: string; // path or HF id
  embedDim: number;
  secretsPath: string | null;
  cohereApiKeyField: string;
  graphProvider: string;
  neo4j: Neo4jConfig;
  configPath: string; // absolute path the JSON was loaded from
}

function argFor(name: string): string | null {
  const idx = process.argv.findIndex((a) => a === name);
  if (idx === -1 || idx === process.argv.length - 1) return null;
  return process.argv[idx + 1] ?? null;
}

export function loadProjectConfig(): ProjectConfig {
  const path =
    argFor('--project-config') ??
    process.env.WIDE_RESEARCHER_PROJECT_CONFIG ??
    null;
  if (!path) {
    throw new Error(
      'wide-researcher MCP server: missing --project-config <path> argv flag ' +
        '(or WIDE_RESEARCHER_PROJECT_CONFIG env var). Re-run `wide-researcher init` ' +
        'to regenerate the per-project MCP stanza.',
    );
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`failed to read project config ${path}: ${(e as Error).message}`);
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`project config ${path} is not valid JSON: ${(e as Error).message}`);
  }

  const project_root = (json.project_root ?? json.projectRoot) as string | undefined;
  const collection_name = (json.collection_name ?? json.collectionName) as string | undefined;
  if (!project_root || !collection_name) {
    throw new Error(
      `project config ${path} missing required keys: project_root + collection_name`,
    );
  }
  const neo4j = (json.neo4j ?? {}) as Record<string, unknown>;
  return {
    projectName: String(json.project_name ?? json.projectName ?? 'project'),
    projectRoot: project_root,
    collectionName: collection_name,
    qdrantUrl: String(json.qdrant_url ?? json.qdrantUrl ?? 'http://127.0.0.1:6333'),
    embedProvider: String(json.embed_provider ?? json.embedProvider ?? 'local-minilm'),
    embedModel: String(
      json.model_path ??
        json.modelPath ??
        json.embed_model ??
        json.embedModel ??
        'sentence-transformers/all-MiniLM-L6-v2',
    ),
    embedDim: Number(json.embed_dim ?? json.embedDim ?? 384),
    secretsPath:
      json.secrets_path || json.secretsPath ? String(json.secrets_path ?? json.secretsPath) : null,
    cohereApiKeyField: String(
      json.cohere_api_key_field ?? json.cohereApiKeyField ?? 'cohere_api_key',
    ),
    graphProvider: String(json.graph_provider ?? json.graphProvider ?? 'qdrant'),
    neo4j: {
      uriEnv: String(neo4j.uri_env ?? neo4j.uriEnv ?? 'NEO4J_URI'),
      userEnv: String(neo4j.user_env ?? neo4j.userEnv ?? 'NEO4J_USERNAME'),
      passwordEnv: String(neo4j.password_env ?? neo4j.passwordEnv ?? 'NEO4J_PASSWORD'),
      databaseEnv: String(neo4j.database_env ?? neo4j.databaseEnv ?? 'NEO4J_DATABASE'),
      uri: neo4j.uri ? String(neo4j.uri) : undefined,
      user: neo4j.user ? String(neo4j.user) : undefined,
      password: neo4j.password ? String(neo4j.password) : undefined,
      database: neo4j.database ? String(neo4j.database) : undefined,
    },
    configPath: path,
  };
}
