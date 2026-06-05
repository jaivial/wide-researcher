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
import { InterpreterWorker } from './interpreter.js';
import {
  wrArchImpact,
  wrCallArgs,
  wrCallers,
  wrCallees,
  wrExports,
  compactSearchResult,
  wrFind,
  wrFile,
  wrImpact,
  wrImporters,
  wrIndexStatus,
  wrSkillAdd,
  wrSkillFind,
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

/* ── Response interpreter ──────────────────────────────────────────────
 * Condenses verbose tool responses via AI so LLM clients don't choke.
 * Toggle off with WIDE_RESEARCHER_DISABLE_INTERPRETER=1.
 */
const DISABLE_INTERPRETER = process.env.WIDE_RESEARCHER_DISABLE_INTERPRETER === '1';
const interpreter = new InterpreterWorker();

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
        runtime: {
          type: 'string',
          description:
            'Filter by runtime: "browser" / "node" / "dotnet" / "python" / "docs" / "unknown".',
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
        include_code_lines: {
          type: 'boolean',
          description: 'Include full code_lines for each result. Default false; compact snippets are returned by default.',
        },
        snippet_lines: {
          type: 'number',
          description: 'Number of snippet lines per result when include_code_lines is false. Default 20.',
        },
        max_bytes: {
          type: 'number',
          description: 'Approximate response byte budget. Default from WIDE_RESEARCHER_MAX_RESPONSE_BYTES or 64000.',
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
        offset: { type: 'number', description: 'Chunk offset for pagination. Default 0.' },
        limit: { type: 'number', description: 'Max chunks to return. Default 20, max 100.' },
        content_mode: {
          type: 'string',
          enum: ['none', 'preview', 'full'],
          description: 'Default "preview". Use "full" only for bounded follow-up reads.',
        },
        max_chars: { type: 'number', description: 'Max content/preview chars per chunk. Default 2000.' },
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
    name: 'wr_call_args',
    description:
      'Enumerate literal arguments at indexed call sites. Use for precise storage-key discovery such as atomWithStorage arg0 instead of broad semantic search.',
    inputSchema: {
      type: 'object',
      properties: {
        callee: { type: 'string', description: 'Optional callee name, e.g. atomWithStorage.' },
        argIndex: { type: 'number', description: 'Optional zero-based argument index.' },
        literal: { type: 'string', description: 'Optional exact literal value.' },
        lang: { type: 'string', description: 'Optional language filter.' },
        path: { type: 'string', description: 'Optional absolute file path filter.' },
        k: { type: 'number', description: 'Max rows. Default 50.' },
      },
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
  {
    name: 'wr_skill_find',
    description:
      'Hybrid semantic + full-text search over the project <collection>_skills collection. Use to locate the right SKILL.md / agents / references chunk for a question about "how do I do X" or "what skill handles Y". Returns skill_name, scope, file_kind, path, heading, preview.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-form natural language or literal terms.' },
        k: { type: 'number', description: 'Max results. Default 10.' },
        skill: { type: 'string', description: 'Filter by exact skill_name (frontmatter name).' },
        scope: { type: 'string', enum: ['project', 'global'], description: 'Filter by source scope.' },
        file_kind: { type: 'string', enum: ['skill', 'agent', 'reference'], description: 'Filter by source file kind.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'wr_skill_add',
    description:
      'Add a markdown document to the <collection>_skills Qdrant collection. Accepts either `path` (abs .md file or directory of SKILL.md / references/*.md / agents/*.md under <project>/.claude/ or ~/.claude/) or `content` (inline markdown). Idempotent — re-adding the same source reuses the deterministic point id.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to a .md file or directory of skill/agent files. Mutually exclusive with `content`.' },
        content: { type: 'string', description: 'Inline markdown content. Mutually exclusive with `path`.' },
        skill_name: { type: 'string', description: 'Override skill_name. Default: parsed from frontmatter or path basename.' },
        description: { type: 'string', description: 'Override description (inline content only).' },
        trigger: { type: 'string', description: 'Comma-separated trigger keywords (inline content only).' },
        file_kind: { type: 'string', enum: ['skill', 'agent', 'reference'], description: 'Override file_kind detection.' },
        scope: { type: 'string', enum: ['project', 'global'], description: 'Override scope detection.' },
        heading: { type: 'string', description: 'Heading label for inline content. Default "(inline)".' },
      },
    },
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
  runtime?: string;
  layer?: string;
  mode?: 'semantic' | 'keyword' | 'hybrid';
  include_code_lines?: boolean;
  snippet_lines?: number;
  max_bytes?: number;
  offset?: number;
  limit?: number;
  content_mode?: 'none' | 'preview' | 'full';
  max_chars?: number;
  include_raw?: boolean;
  callee?: string;
  argIndex?: number;
  literal?: string;
  content?: string;
  skill?: string;
  skillName?: string;
  fileKind?: string;
  scope?: string;
  heading?: string;
  trigger?: string;
}

const DEFAULT_MAX_RESPONSE_BYTES = Number.parseInt(process.env.WIDE_RESEARCHER_MAX_RESPONSE_BYTES ?? '64000', 10);

function responseBudget(args?: ToolArgs): number {
  const requested = typeof args?.max_bytes === 'number' ? args.max_bytes : DEFAULT_MAX_RESPONSE_BYTES;
  return Math.min(Math.max(8192, requested || 64000), 512000);
}

function truncatePayload(payload: unknown, maxBytes: number): unknown {
  const text = JSON.stringify(payload, null, 2);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxBytes) return payload;
  return {
    truncated: true,
    original_bytes: bytes,
    returned_bytes_budget: maxBytes,
    summary: 'Response exceeded MCP byte budget. Retry with lower k, narrower filters, pagination, or unsafe/full flags only for targeted follow-up reads.',
    preview: text.slice(0, Math.max(1000, maxBytes - 1000)),
  };
}

function fitToBudget<T>(payload: T, maxBytes: number): T | ReturnType<typeof truncatePayload> {
  const text = JSON.stringify(payload, null, 2);
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return payload;
  const obj = payload as { results?: Array<Record<string, unknown>> };
  if (Array.isArray(obj.results) && obj.results.length > 0) {
    for (const lines of [10, 6, 3, 1]) {
      const slim = {
        ...obj,
        results: obj.results.map((r) => {
          const snip = r.snippet_lines;
          if (Array.isArray(snip)) {
            return { ...r, snippet_lines: snip.slice(0, lines), omitted_lines: r.omitted_lines };
          }
          return r;
        }),
      };
      if (Buffer.byteLength(JSON.stringify(slim, null, 2), 'utf8') <= maxBytes) return slim as T;
    }
    for (const keep of [3, 2, 1]) {
      if (obj.results.length <= keep) break;
      const slim = {
        ...obj,
        results: obj.results.slice(0, keep),
        dropped_results: obj.results.length - keep,
      };
      if (Buffer.byteLength(JSON.stringify(slim, null, 2), 'utf8') <= maxBytes) return slim as T;
    }
  }
  return truncatePayload(payload, maxBytes);
}

function jsonContent(payload: unknown, maxBytes = DEFAULT_MAX_RESPONSE_BYTES): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(truncatePayload(payload, maxBytes), null, 2) }] };
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
        runtime: a.runtime ?? null,
        layer: a.layer ?? null,
        mode: a.mode ?? 'hybrid',
        include_code_lines: a.include_code_lines === true,
        snippet_lines: a.snippet_lines ?? 20,
        max_bytes: responseBudget(a),
        rerank: !RERANK_DISABLED,
      },
      async () => {
        const results = await wrFind({
          embed,
          rerank: rerankFn,
          query: a.query ?? '',
          k: a.k ?? 10,
          lang: a.lang ?? null,
          role: a.role ?? null,
          runtime: a.runtime ?? null,
          layer: a.layer ?? null,
          mode: a.mode ?? 'hybrid',
        });
        const built = {
          tool: 'wr_find',
          query: a.query,
          mode: a.mode ?? 'hybrid',
          compact: a.include_code_lines !== true,
          results: results.map((r) => compactSearchResult(r, a.snippet_lines ?? 20, a.include_code_lines === true)),
        };
        return jsonContent(fitToBudget(built, responseBudget(a)) as typeof built, responseBudget(a));
      },
    ),
  wr_file: async (a) => {
    const result = await wrFile({
      path: a.path ?? '',
      offset: a.offset,
      limit: a.limit,
      contentMode: a.content_mode,
      maxChars: a.max_chars,
    });
    return jsonContent({ tool: 'wr_file', path: a.path, count: result.returned, ...result }, responseBudget(a));
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
  wr_call_args: async (a) => {
    const results = await wrCallArgs({
      callee: a.callee ?? null,
      argIndex: a.argIndex ?? null,
      literal: a.literal ?? null,
      lang: a.lang ?? null,
      path: a.path ?? null,
      k: a.k ?? 50,
    });
    return jsonContent({ tool: 'wr_call_args', count: results.length, results }, responseBudget(a));
  },
  wr_callers: async (a) => {
    const results = await wrCallers({ symbol: a.symbol ?? '', k: a.k ?? 20 });
    return jsonContent({ tool: 'wr_callers', symbol: a.symbol, count: results.length, results }, responseBudget(a));
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
  wr_skill_find: async (a) =>
    withResultCache(
      {
        tool: 'wr_skill_find',
        q: a.query ?? '',
        k: a.k ?? 10,
        skill: a.skill ?? null,
        scope: a.scope ?? null,
        file_kind: a.fileKind ?? null,
      },
      async () => {
        const results = await wrSkillFind({
          embed,
          query: a.query ?? '',
          k: a.k ?? 10,
          skill: a.skill ?? null,
          scope: (a.scope as 'project' | 'global' | null) ?? null,
          fileKind: (a.fileKind as 'skill' | 'agent' | 'reference' | null) ?? null,
        });
        return jsonContent(
          { tool: 'wr_skill_find', query: a.query, count: results.length, results },
          responseBudget(a),
        );
      },
    ),
  wr_skill_add: async (a) => {
    const result = await wrSkillAdd(embed, {
      path: a.path,
      content: a.content,
      skill_name: a.skillName,
      description: a.description,
      trigger: a.trigger,
      file_kind: a.fileKind as 'skill' | 'agent' | 'reference' | undefined,
      scope: a.scope as 'project' | 'global' | undefined,
      heading: a.heading,
    });
    return jsonContent(
      { tool: 'wr_skill_add', ...result },
      responseBudget(a),
    );
  },
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
    const toolArgs = (args ?? {}) as ToolArgs;
    const response = await handler(toolArgs);

    // If interpreter is active, condense the response for LLM clients.
    if (!DISABLE_INTERPRETER) {
      const rawText = response.content[0]?.text ?? '';
      let rawPayload: Record<string, unknown> = {};
      try {
        rawPayload = JSON.parse(rawText) as Record<string, unknown>;
      } catch {
        /* not JSON — skip interpretation */
        return response;
      }

      // Extract the query/description for context.
      const queryText =
        rawPayload.query as string | undefined ??
        rawPayload.description as string | undefined ??
        rawPayload.symbol as string | undefined ??
        rawPayload.symbolOrFile as string | undefined ??
        rawPayload.pathOrModule as string | undefined ??
        rawPayload.path as string | undefined ??
        null;

      const result = await interpreter.interpret(name, queryText, rawPayload);

      if (result.ok && result.interpretation) {
        // Prepend a concise interpretation block and keep the full
        // raw data as a secondary section for consumers that need it.
        response.content = [
          {
            type: 'text',
            text: JSON.stringify(
              truncatePayload({
                interpretation: result.interpretation,
                tokens_saved: Math.max(0, result.tokens_in - result.tokens_out),
                tool: rawPayload.tool ?? name,
                data: toolArgs.include_raw === true ? rawPayload : undefined,
              }, responseBudget(toolArgs)),
              null,
              2,
            ),
          },
        ];
      }
    }

    return response;
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
  try {
    await interpreter.close();
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
