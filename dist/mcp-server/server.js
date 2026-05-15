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
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { loadProjectConfig } from './config.js';
import { EmbedWorker } from './embed.js';
import { wrFind, wrFile, wrImpact, wrIndexStatus } from './tools.js';
import { pyPackageRoot, venvPython } from '../utils/paths.js';
import path from 'node:path';
const cfg = loadProjectConfig();
const embedWorker = new EmbedWorker({
    pythonPath: venvPython(),
    scriptPath: path.join(pyPackageRoot(), 'scripts', 'embed_worker.py'),
    projectConfigPath: cfg.configPath,
});
const embed = (text) => embedWorker.embed(text);
/* ── Tool catalog ───────────────────────────────────────────────────── */
const TOOLS = [
    {
        name: 'wr_find',
        description: 'Unified codebase search (Qdrant + MiniLM-L6). One tool, three modes: semantic (vector similarity — best for concepts), keyword (full-text on payload — best for literal identifiers like "useEffect"), hybrid (default — Qdrant native RRF fusion). Returns top-k chunks with file path, line range, symbol info, a 500-char preview, and numbered code_lines for the matched chunk.',
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
                    description: 'Filter by language: "typescript" / "tsx" / "python" / "go" / "rust" / "csharp" / "json" / "markdown" / "css" / "text".',
                },
                role: {
                    type: 'string',
                    description: 'Filter by role: "frontend" / "backend" / "docs" / "tests" / "config" / "stories" / "other".',
                },
                layer: {
                    type: 'string',
                    description: 'Filter by atomic-design layer: "atoms" / "ui" / "hooks" / "helpers" / "components" / "pages" / "layouts" / "api" / "signalr" / "locales" / "stories" / "types" / "constants".',
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
        description: 'Fetch every indexed chunk of one file, ordered by chunk_index. Use after wr_find has located the right file and you want full structured content (symbol_kind, symbol_name, line ranges, full text).',
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
        description: 'Given a natural-language description of a change ("add a per-tenant rate limit on uploads"), returns the ranked list of FILES likely to need edits. Hybrid search over a wide pool, weights down derivative files (locales/stories/tests), groups by file_path with top symbol names. Go-to tool for "what does this change affect" reasoning.',
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
        name: 'wr_index_status',
        description: 'Index health. Returns collection name, status (green/yellow/red), points_count, vector dim.',
        inputSchema: { type: 'object', properties: {} },
    },
];
function jsonContent(payload) {
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}
const HANDLERS = {
    wr_find: async (a) => jsonContent({
        tool: 'wr_find',
        query: a.query,
        mode: a.mode ?? 'hybrid',
        results: await wrFind({
            embed,
            query: a.query ?? '',
            k: a.k ?? 10,
            lang: a.lang ?? null,
            role: a.role ?? null,
            layer: a.layer ?? null,
            mode: a.mode ?? 'hybrid',
        }),
    }),
    wr_file: async (a) => {
        const chunks = await wrFile({ path: a.path ?? '' });
        return jsonContent({ tool: 'wr_file', path: a.path, count: chunks.length, chunks });
    },
    wr_impact: async (a) => {
        const files = await wrImpact({
            embed,
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
    wr_index_status: async () => jsonContent({ tool: 'wr_index_status', ...(await wrIndexStatus()) }),
};
/* ── Server wiring ──────────────────────────────────────────────────── */
const server = new Server({ name: 'wide-researcher', version: '0.1.0-alpha.0' }, { capabilities: { tools: {} } });
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
        return await handler((args ?? {}));
    }
    catch (err) {
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        error: err.message,
                        stack: err.stack,
                    }),
                },
            ],
            isError: true,
        };
    }
});
async function shutdown() {
    try {
        await embedWorker.close();
    }
    catch {
        /* ignore */
    }
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[wide-researcher mcp] ready · project=${cfg.projectName} collection=${cfg.collectionName}\n`);
//# sourceMappingURL=server.js.map