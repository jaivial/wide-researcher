#!/usr/bin/env node
// wide-researcher MCP server (stdio transport, Qdrant backend).
//
// Three tools — wr_find / wr_file / wr_impact — plus an index-status
// helper. Per-project config comes from argv:
//
//   node dist/mcp-server/server.js --project-config /abs/.wide-researcher/config.json
//
// Project context (collection name, qdrant URL, embed model path) lives
// in that JSON file. The MCP server spawns the Python embed worker
// inside the global venv at ~/.wide-researcher/venv/python so it
// shares the model cache with the indexer.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { loadProjectConfig } from './config.js';
import { EmbedWorker } from './embed.js';
import {
  wrArchImpact,
  wrCallers,
  wrCallees,
  wrExports,
  wrFind,
  wrFile,
  wrImpact,
  wrImporters,
  wrIndexStatus,
  wrSymbolFind,
} from './tools.js';
import { pyPackageRoot, venvPython } from '../utils/paths.js';
import { getResult, putResult } from '../utils/cache.js';
import path from 'node:path';

const cfg = loadProjectConfig();

const embedWorker = new EmbedWorker({
  pythonPath: venvPython(),
  scriptPath: path.join(pyPackageRoot(), 'scripts', 'embed_worker.py'),
  projectConfigPath: cfg.configPath,
  embedProvider: cfg.embedProvider,
  embedModel: cfg.embedModel,
  embedDim: cfg.embedDim,
  secretsPath: cfg.secretsPath,
  cohereApiKeyField: cfg.cohereApiKeyField,
});

const embed = (text: string) => embedWorker.embed(text);
const rerank = (query: string, docs: string[]) => embedWorker.rerank(query, docs);
const RERANK_DISABLED = process.env.WIDE_RESEARCHER_DISABLE_RERANK === '1';
const rerankFn = RERANK_DISABLED ? undefined : rerank;

/* ── Tool catalog ───────────────────────────────────────────────────── */

const TOOLS = [
  {
    name: 'wr_find',
    description:
      'Unified codebase search (Qdrant + MiniLM-L6). One tool, three modes: semantic (vector similarity — best for concepts), keyword (full-text on payload — best for literal identifiers like "useEffect"), hybrid (default — Qdrant native RRF fusion). Returns top-k chunks with file path, line range, symbol info, a 500-char preview, and numbered code_lines for the matched chunk.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Free-form natural language or literal terms.',
        },
        k: { type: 'number', description: 'Max results. Default 10.' },
        lang: {
          type: 'string',
          description:
            'Filter by language: "typescript" / "tsx" / "python" / "go" / "rust" / "csharp" / "json" / "markdown" / "css" / "text".',
        },
        role: {
          type: 'string',
          description:
            'Filter by role: "frontend" / "backend" / "docs" / "tests" / "config" / "stories" / "other".',
        },
        layer: {
          type: 'string',
          description:
            'Filter by atomic-design layer: "atoms" / "ui" / "hooks" / "helpers" / "components" / "pages" / "layouts" / "api" / "signalr" / "locales" / "stories" / "types" / "constants".',
        },
        mode: {
          type: 'string',
          enum: ['semantic', 'keyword', 'hybrid'],
          description: 'Default "hybrid".',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'wr_file',
    description:
      'Fetch every indexed chunk of one file, ordered by chunk_index. Use after wr_find has located the right file and you want full structured content (symbol_kind, symbol_name, line ranges, full text).',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file as stored in the index.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'wr_impact',
    description:
      'Given a natural-language description of a change ("add a per-tenant rate limit on uploads"), returns the ranked list of FILES likely to need edits. Hybrid search over a wide pool, weights down derivative files (locales/stories/tests), groups by file_path with top symbol names. Go-to tool for "what does this change affect" reasoning.',
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Natural-language description of the proposed change.',
        },
        k: { type: 'number', description: 'Max files to return. Default 15.' },
      },
      required: ['description'],
    },
  },
  {
    name: 'wr_symbol_find',
    description:
      'Find indexed AST/symbol graph nodes in the project symbol collection. Best for declarations, functions, classes, interfaces, exports, calls, type relations.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Symbol/concept query.' },
        k: { type: 'number', description: 'Max symbols. Default 10.' },
        kind: { type: 'string', description: 'Optional symbol kind filter: function/class/interface/type/enum/component/method.' },
        lang: { type: 'string', description: 'Optional language filter: typescript/tsx/csharp.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'wr_callers',
    description:
      'Find chunks whose structural graph payload calls or references the given symbol name.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Function/class/type symbol name or FQN.' },
        k: { type: 'number', description: 'Max chunks. Default 20.' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'wr_callees',
    description:
      'Return calls emitted by chunks matching a symbol name/FQN or all chunks in a file path.',
    inputSchema: {
      type: 'object',
      properties: {
        symbolOrFile: { type: 'string', description: 'Symbol/FQN or absolute file path.' },
        k: { type: 'number', description: 'Max chunks. Default 20.' },
      },
      required: ['symbolOrFile'],
    },
  },
  {
    name: 'wr_importers',
    description:
      'Find chunks/files importing a module string or resolved file path.',
    inputSchema: {
      type: 'object',
      properties: {
        pathOrModule: { type: 'string', description: 'Import module string or absolute resolved file path.' },
        k: { type: 'number', description: 'Max chunks. Default 20.' },
      },
      required: ['pathOrModule'],
    },
  },
  {
    name: 'wr_exports',
    description: 'Return exports discovered in structural payloads for one absolute file path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path.' },
        k: { type: 'number', description: 'Max chunks. Default 100.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'wr_arch_impact',
    description:
      'Architecture impact analysis combining semantic chunk hits, symbol-node hits, callers, importers, exports, and type-relation expansion.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Natural-language change description.' },
        k: { type: 'number', description: 'Max files. Default 15.' },
      },
      required: ['description'],
    },
  },
  {
    name: 'wr_index_status',
    description:
      'Index health. Returns collection name, status (green/yellow/red), points_count, vector dim.',
    inputSchema: { type: 'object', properties: {} },
  },
];

interface ToolArgs {
  query?: string;
  description?: string;
  path?: string;
  symbol?: string;
  symbolOrFile?: string;
  pathOrModule?: string;
  k?: number;
  lang?: string;
  kind?: string;
  role?: string;
  layer?: string;
  mode?: 'semantic' | 'keyword' | 'hybrid';
}

function jsonContent(payload: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

let cachedPointsCount: number | null = null;
let cachedPointsCountAt = 0;
const POINTS_COUNT_TTL_MS = 30_000;

/** Cached collection size used to invalidate result cache on index growth. */
async function getPointsCount(): Promise<number> {
  const now = Date.now();
  if (cachedPointsCount !== null && now - cachedPointsCountAt < POINTS_COUNT_TTL_MS) {
    return cachedPointsCount;
  }
  try {
    const info = await wrIndexStatus();
    cachedPointsCount = info.points_count ?? 0;
  } catch {
    cachedPointsCount = 0;
  }
  cachedPointsCountAt = now;
  return cachedPointsCount;
}

async function withResultCache(
  cacheKey: Record<string, unknown>,
  compute: () => Promise<{ content: { type: 'text'; text: string }[] }>,
): Promise<{ content: { type: 'text'; text: string }[] }> {
  const pts = await getPointsCount();
  const hit = getResult(cacheKey, pts);
  if (hit) {
    return { content: [{ type: 'text', text: hit }] };
  }
  const result = await compute();
  const text = result.content[0]?.text;
  if (typeof text === 'string') putResult(cacheKey, pts, text);
  return result;
}

type Handler = (a: ToolArgs) => Promise<ReturnType<typeof jsonContent>>;

const HANDLERS: Record<string, Handler> = {
  wr_find: async (a) =>
    withResultCache(
      {
        tool: 'wr_find',
        q: a.query ?? '',
        k: a.k ?? 10,
        lang: a.lang ?? null,
        role: a.role ?? null,
        layer: a.layer ?? null,
        mode: a.mode ?? 'hybrid',
        rerank: !RERANK_DISABLED,
      },
      async () =>
        jsonContent({
          tool: 'wr_find',
          query: a.query,
          mode: a.mode ?? 'hybrid',
          results: await wrFind({
            embed,
            rerank: rerankFn,
            query: a.query ?? '',
            k: a.k ?? 10,
            lang: a.lang ?? null,
            role: a.role ?? null,
            layer: a.layer ?? null,
            mode: a.mode ?? 'hybrid',
          }),
        }),
    ),
  wr_file: async (a) => {
    const chunks = await wrFile({ path: a.path ?? '' });
    return jsonContent({ tool: 'wr_file', path: a.path, count: chunks.length, chunks });
  },
  wr_impact: async (a) =>
    withResultCache(
      { tool: 'wr_impact', d: a.description ?? '', k: a.k ?? 15, rerank: !RERANK_DISABLED },
      async () => {
        const files = await wrImpact({
          embed,
          rerank: rerankFn,
          description: a.description ?? '',
          k: a.k ?? 15,
        });
        return jsonContent({
          tool: 'wr_impact',
          description: a.description,
          count: files.length,
          files,
        });
      },
    ),
  wr_symbol_find: async (a) =>
    withResultCache(
      {
        tool: 'wr_symbol_find',
        q: a.query ?? '',
        k: a.k ?? 10,
        kind: a.kind ?? null,
        lang: a.lang ?? null,
        rerank: !RERANK_DISABLED,
      },
      async () => {
        const results = await wrSymbolFind({
          embed,
          rerank: rerankFn,
          query: a.query ?? '',
          k: a.k ?? 10,
          kind: a.kind ?? null,
          lang: a.lang ?? null,
        });
        return jsonContent({ tool: 'wr_symbol_find', query: a.query, count: results.length, results });
      },
    ),
  wr_callers: async (a) => {
    const results = await wrCallers({ symbol: a.symbol ?? '', k: a.k ?? 20 });
    return jsonContent({ tool: 'wr_callers', symbol: a.symbol, count: results.length, results });
  },
  wr_callees: async (a) => {
    const result = await wrCallees({ symbolOrFile: a.symbolOrFile ?? '', k: a.k ?? 20 });
    return jsonContent({ tool: 'wr_callees', symbolOrFile: a.symbolOrFile, ...result });
  },
  wr_importers: async (a) => {
    const results = await wrImporters({ pathOrModule: a.pathOrModule ?? '', k: a.k ?? 20 });
    return jsonContent({ tool: 'wr_importers', pathOrModule: a.pathOrModule, count: results.length, results });
  },
  wr_exports: async (a) => {
    const result = await wrExports({ path: a.path ?? '', k: a.k ?? 100 });
    return jsonContent({ tool: 'wr_exports', path: a.path, ...result });
  },
  wr_arch_impact: async (a) =>
    withResultCache(
      { tool: 'wr_arch_impact', d: a.description ?? '', k: a.k ?? 15, rerank: !RERANK_DISABLED },
      async () => {
        const files = await wrArchImpact({ embed, rerank: rerankFn, description: a.description ?? '', k: a.k ?? 15 });
        return jsonContent({ tool: 'wr_arch_impact', description: a.description, count: files.length, files });
      },
    ),
  wr_index_status: async () =>
    jsonContent({ tool: 'wr_index_status', ...(await wrIndexStatus()) }),
};

/* ── Server wiring ──────────────────────────────────────────────────── */

const server = new Server(
  { name: 'wide-researcher', version: '0.1.0-alpha.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = HANDLERS[name];
  if (!handler) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
      isError: true,
    };
  }
  try {
    return await handler((args ?? {}) as ToolArgs);
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: (err as Error).message,
            stack: (err as Error).stack,
          }),
        },
      ],
      isError: true,
    };
  }
});

async function shutdown(): Promise<void> {
  try {
    await embedWorker.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);

process.stderr.write(
  `[wide-researcher mcp] ready · project=${cfg.projectName} collection=${cfg.collectionName}\n`,
);
