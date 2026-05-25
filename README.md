# wide-researcher

[![npm version](https://img.shields.io/badge/npm-v0.1.0--alpha.24-blue.svg)](https://www.npmjs.com/package/wide-researcher)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](#requirements)
[![python](https://img.shields.io/badge/python-%3E%3D3.11-yellow.svg)](#requirements)

> Drop a local Qdrant-backed semantic code index plus AST/symbol graph
> index into any project. Claude Code gets MCP tools for semantic search,
> symbol search, callers, callees, importers, exports, hybrid impact,
> and full-file drill-down.
>
> Plus an **impact-radius diagram** that ranks every file a task is
> likely to touch, grouped by semantic and structural evidence, rendered
> as a standalone HTML page.
>
> One command sets it up. Indexes update automatically on save.
> Everything runs locally except optional cloud embedding providers. No telemetry.

---

## One-line install

```bash
# In any project's root:
npx wide-researcher init
```

That single command:

1. **Interactive embed-model picker** — choose between four options:
   - **MiniLM-L6** (free, local, 384-d) — recommended default
   - **BGE-Large-en-v1.5** (free, local, 1024-d) — 55% better than MiniLM
   - **GTE-Qwen2-1.5B** (free, local, 1536-d) — matches Cohere v4 quality at zero cost
   - **Cohere Embed v4** (paid, cloud API, 1536-d) — prompts for your Cohere production API key, stores it at `~/.wide-researcher/secrets.json` mode 0600
2. Installs **Qdrant** v1.18 (native binary, no Docker) into `~/.wide-researcher/qdrant/`.
3. Downloads the chosen local model — OR — validates your Cohere key.
4. Bootstraps a Python venv at `~/.wide-researcher/venv/` with the indexer dependencies (incl. the `cohere` SDK for the cloud path).
5. Registers a `systemd --user` unit (Linux) or `launchd` plist (macOS) so Qdrant + the file watcher survive reboots.
6. Drops a project-scoped Claude Code agent + skill into `<project>/.claude/`, plus the binding hook that injects `<MCP-MANDATORY-FOR-CODE-SEARCH>` on every prompt.
7. Runs the initial full-codebase index. Time scales with codebase size — a 5 000-file repo takes ~5 min on MiniLM, ~3 min on Cohere (network-bound, batched).
8. Adds AST/symbol payload fields to indexed TS/TSX/C# chunks and can build a separate `<collection>_symbols` Qdrant collection for symbol-node search.

After `init`, **edit any file and the index updates automatically.**

### Embed model comparison

| Model | Dims | Download | RAM needed | Quality | Cost |
|---|---|---|---|---|---|
| MiniLM-L6 | 384 | ~80 MB | ~500 MB | Good | Free |
| BGE-Large-en-v1.5 | 1024 | ~1.3 GB | ~1.5 GB | Great (English) | Free |
| GTE-Qwen2-1.5B | 1536 | ~1.5 GB | ~2.5 GB | Excellent (multilingual) | Free |
| Cohere Embed v4 | 1536 | — | ~512 MB | Excellent (multilingual) | ~$0.10/1M tokens |

**Quality ranking:** Cohere v4 ≈ GTE-Qwen2 > BGE-Large > MiniLM.

**Recommendation:** Start with MiniLM (default). If you need better multilingual/code semantics and have the RAM, use GTE-Qwen2 — same quality as Cohere, zero cost, fully offline. Use Cohere only if you want cloud quality without the RAM overhead of a local model.

### Non-interactive (CI / scripted installs)

```bash
# MiniLM, skip the picker
npx wide-researcher init --embed-provider local-minilm

# BGE-Large
npx wide-researcher init --embed-provider local-bge-large

# GTE-Qwen2
npx wide-researcher init --embed-provider local-gte-qwen2

# Cohere, key from CLI flag (will still validate against /v2/embed)
npx wide-researcher init --embed-provider cohere --cohere-api-key $COHERE_KEY
```

### Adding a second project

If `init` has already run on this machine, dropping wide-researcher into another project is a single command that skips the global infra:

```bash
# In the new project's root:
npx wide-researcher add
```

### Switching embed models

Switching between models that share the same vector dimensionality (e.g. GTE-Qwen2 ↔ Cohere, both 1536-d) doesn't require a reindex — the existing vectors stay valid. Switching to a different dimensionality triggers a full reindex; `init` will offer to snapshot the old collection first.

### Upgrading to a newer release

For machines that already ran `init` at least once, refresh the per-project bundle without touching the Qdrant collection, secrets, or any custom config:

```bash
# 1. pull the new npm release
npm install -g wide-researcher@latest

# 2. inside each project that uses wide-researcher
wide-researcher update
```

`update` rewrites the things that change between alpha releases (`.claude/skills/`, `.claude/agents/`, the `.mcp.json` stanza, the prompt-submit hook, and the systemd / launchd indexer unit), upgrades the venv's pip deps in place, and restarts the watcher daemon so it picks up the new code. It explicitly does **not** touch your Qdrant collection, `secrets.json`, or your project's `.wide-researcher/config.json` — so custom excludes, batch sizes, or graph-backend choices survive.

Flags:

```bash
wide-researcher update --no-pip-upgrade   # skip `pip install -U -r requirements.txt`
wide-researcher update --no-restart       # skip systemd/launchd restart
wide-researcher update --no-supervisor    # skip unit rewrite + restart
```

After running, reopen Claude Code so it spawns a fresh MCP server against the new dist code.

---

## What you get inside Claude Code

MCP tools become available the moment Claude opens the project:

| Tool | What it does |
|---|---|
| `wr_arch_impact(description, k?)` | Hybrid semantic + AST/symbol graph impact analysis. **Use first for "what does this change affect".** |
| `wr_symbol_find(query, k?, kind?, lang?)` | Symbol-node search for functions, classes, interfaces, React components, C# methods/types. |
| `wr_callers(symbol, k?)` | Files/chunks that call or reference a symbol. |
| `wr_callees(symbolOrFile, k?)` | Calls made by a matching symbol or file. |
| `wr_importers(pathOrModule, k?)` | Files importing a path or module. |
| `wr_exports(path, k?)` | Exports declared by one file. |
| `wr_find(query, mode?, lang?, role?, layer?)` | Chunk-level semantic / keyword / hybrid search. Hybrid mode = Qdrant native RRF fusion. |
| `wr_file(path)` | All chunks for one file, ordered. Full content, not preview. |
| `wr_impact(description, k?)` | Legacy semantic file-grouped impact analysis. |
| `wr_index_status` | Collection health (green/yellow/red) + counts. |

Plus a project-scoped **agent** (`.claude/agents/wide-researcher.md`) that wraps the tools into a graph-aware workflow:

1. `wr_arch_impact` for file-level impact with semantic + structural evidence
2. `wr_symbol_find`, `wr_callers`, `wr_importers`, `wr_exports` for exact graph drill-downs
3. `wr_file` for full indexed file content
4. `wr_find` for chunk-level concept lookups
5. Synthesise a structured ring-grouped report

---

## CLI surface

```
wide-researcher init                 first-time setup on this machine
wide-researcher add                  add to a new project (skip global)
wide-researcher update               refresh project bundle after npm upgrade
                                      (keeps qdrant data + secrets + config)
wide-researcher reindex              incremental reindex
wide-researcher reindex --force      full rebuild
wide-researcher status               qdrant + indexer + last-index time
wide-researcher status --json        machine-readable
wide-researcher search "<query>"     terminal-side smoke search
wide-researcher symbol-index         payload-only AST/symbol update for TS/TSX/C# chunks
wide-researcher symbol-index --with-node-embeddings
                                      also build/update <collection>_symbols
wide-researcher neo4j-sync           optional sync from Qdrant symbol payloads to Neo4j
wide-researcher uninstall            remove from this project
wide-researcher uninstall --all      also nuke ~/.wide-researcher/
```

### Example `status` output

```
project     myapp                    slug=myapp_a1b2c3d4
installed   ✓  /home/u/myapp/.wide-researcher/config.json
qdrant bin  ✓  /home/u/.wide-researcher/qdrant/qdrant
qdrant svc  ✓  http://127.0.0.1:6333
collection  myapp_a1b2c3d4
  points    12891
  vector    384-d (green)
indexer     active
last index  2026-05-12T14:30:28Z
logs        /home/u/.wide-researcher/logs/indexer-myapp_a1b2c3d4.log
```

---

## Architecture

```
        ┌────────────────────────────────────────────────────┐
        │  Claude Code (in your project, MCP-aware)          │
        └─────────────────┬──────────────────────────────────┘
                          │ MCP tool call: wr_arch_impact /
                          │ wr_symbol_find / wr_callers /
                          │ wr_find / wr_file / wr_index_status
                          ▼
        ┌────────────────────────────────────────────────────┐
        │  wide-researcher-mcp (Node, stdio transport)       │
        │  spawned by `<project>/.mcp.json`                  │
        └───────────────┬──────────────┬─────────────────────┘
                        │              │
                        │ Qdrant REST  │ Python subprocess
                        │              │ (embed worker)
                        ▼              ▼
            ┌─────────────────┐  ┌─────────────────────┐
            │ Qdrant 1.18     │  │ EmbedProvider        │
            │ 127.0.0.1:6333  │  │ ┌─ MiniLMProvider   │
            │ HNSW + payload  │  │ ├─ BGELargeProvider │
            │ indexes         │  │ ├─ GTEQwen2Provider │
            │                 │  │ └─ CohereProvider   │
            └────────┬────────┘  │   (bounded httpx    │
                     │           │    pool, RSS guard,  │
                     │           │    per-chunk GC)     │
                     │           └─────────────────────┘
                     ▼
            ┌─────────────────┐
            │ per-project     │
            │ code collection │
            │ <name>_<sha1>   │
            └────────┬────────┘
                     │ AST/symbol payload enrichment
                     ▼
            ┌─────────────────┐
            │ symbol-node     │
            │ collection      │
            │ <name>_symbols  │
            └─────────────────┘

        ┌────────────────────────────────────────────────────┐
        │  filesystem watcher daemon                         │
        │  (Python · watchdog · 1.5 s debounce ·             │
        │   subprocess-per-file flush capped at 64/tick)     │
        └─────────────────┬──────────────────────────────────┘
                          │
                          │ writes to Qdrant
                          ▼
                  (same collection above)
```

### AST/symbol graph indexing

For TypeScript, TSX, and C# projects, `wide-researcher symbol-index` adds structural payloads to existing code chunks without re-embedding the code collection:

- declarations: functions, classes, interfaces, types, enums, methods, components
- imports and resolved relative imported files
- exports and re-exports
- calls and references
- type refs, base types, and interface implementations

`wide-researcher symbol-index --with-node-embeddings` also creates or updates a second Qdrant collection named `<collection>_symbols`. Those symbol nodes use the same configured embed provider, model, and vector dimension as the code collection. Existing code vectors are not rebuilt.

### Hybrid architecture impact

`wr_arch_impact` combines:

- semantic/keyword hits from the code collection
- symbol-node hits from `<collection>_symbols`
- structural expansion through callers, importers, exports, and type users

Use it before multi-file changes. Use `wr_callers`, `wr_importers`, `wr_symbol_find`, and `wr_exports` for exact structural questions.

### Optional Neo4j graph backend

Qdrant remains the default graph provider. If you want exact graph traversal in Neo4j, use auto-setup:

```bash
wide-researcher neo4j-setup
```

This command verifies Neo4j availability, validates Bolt connectivity, stores credentials in project config, regenerates the MCP stanza with Neo4j env vars, and runs an initial sync.

You can also configure credentials directly in `.wide-researcher/config.json`:

```json
{
  "graph_provider": "neo4j",
  "neo4j": {
    "uri_env": "NEO4J_URI",
    "user_env": "NEO4J_USERNAME",
    "password_env": "NEO4J_PASSWORD",
    "database_env": "NEO4J_DATABASE",
    "uri": "bolt://127.0.0.1:7687",
    "user": "neo4j",
    "password": "your-password",
    "database": "neo4j"
  }
}
```

Precedence is: environment variable > direct config.json credential field.

When Neo4j is configured, running `wide-researcher init` / `wide-researcher add` re-generates `.mcp.json` and injects `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, and `NEO4J_DATABASE` automatically.

To sync graph payloads manually at any time, run:

```bash
wide-researcher neo4j-sync
```

If Neo4j is not configured, graph tools keep using Qdrant and the Neo4j sync command exits with a clear disabled-state message. For graph visualization, see Neo4j Browser/Bloom examples in the Neo4j Graph Visualization section below.

### Memory management

The indexer has built-in OOM protection:

- **RSS guard**: Before each API call, the process checks its peak RSS. If it exceeds `max_rss_mb` (default: 80% of system RAM), the embed provider tears down (closing httpx pools, releasing model weights), runs a full GC, and recreates itself.
- **Periodic teardown**: Every 200 files, the provider is fully torn down and recreated regardless — prevents slow leaks in httpx connection pools and PyTorch intermediate buffers.
- **Per-chunk GC**: After every 96-text embedding batch, `gc.collect()` runs immediately.
- **Chunk cap**: Files producing more than `chunk_cap` chunks (default: 500) are truncated to prevent a single dense file from spiraling memory usage.
- **Subprocess isolation**: The filesystem watcher spawns a fresh `python -m indexer file <path>` subprocess per file. When the subprocess exits, the kernel reclaims all memory — leaks are structurally impossible in this path.

#### Configurable limits

Add these to your project's `.wide-researcher/config.json`:

```json
{
  "max_rss_mb": 2048,
  "chunk_cap": 300
}
```

| Key | Default | Description |
|---|---|---|
| `max_rss_mb` | 80% of system RAM | RSS ceiling in MB. Provider teardown + GC triggers when exceeded. |
| `chunk_cap` | 500 | Max chunks per file. Dense files beyond this are truncated with a warning. |

### Per-project paths

```
<your-project>/
├── .claude/
│   ├── agents/wide-researcher.md
│   └── skills/wide-research/
│       ├── SKILL.md
│       └── references/{mcp-tools,impact-diagram}.md
├── .mcp.json                         ← wide-researcher MCP stanza
└── .wide-researcher/
    ├── config.json                   ← collection name, paths, ignores, memory limits
    └── runs/<slug>/                  ← research-context.json + diagram
```

### Global paths

```
~/.wide-researcher/
├── qdrant/                           ← native binary + storage
│   ├── qdrant
│   ├── config.yaml
│   └── storage/                      ← every project's collection
├── models/
│   ├── all-MiniLM-L6-v2/             ← 384-d model weights
│   ├── bge-large-en-v1.5/            ← 1024-d model weights
│   └── gte-Qwen2-1.5B-instruct/      ← 1536-d model weights
├── venv/                             ← python deps
├── secrets.json                      ← API keys (mode 0600)
└── logs/                             ← per-project indexer logs
```

---

## Requirements

- **Linux** (any modern distro with `systemd --user`) or **macOS** (10.15+) or **Windows 10/11** (x86_64)
- **Node.js** 20+
- **Python** 3.11+
- **RAM**: 512 MB minimum (Cohere), 1.5 GB+ recommended (local models), 2.5 GB+ for GTE-Qwen2
- **~200 MB free disk** for Qdrant + MiniLM model (up to ~1.7 GB if all local models are installed)

**Windows note:** v0.1 supports native Windows for everything except process supervision. Qdrant binary, Python venv, embed model, MCP server, Claude bundle, and the impact-diagram hook all install and run natively. The systemd / launchd auto-start daemons are not yet ported — Windows users run `qdrant.exe` and the indexer watcher manually (or wrap with `nssm.exe` / Task Scheduler). Native auto-start lands in v0.2.

---

## Privacy

`wide-researcher` is **local-first**. It does not phone home, does not collect telemetry, and never sends your code anywhere — **unless** you choose the Cohere embed provider.

### Network calls by provider

| Provider | At install | At query time | What's sent |
|---|---|---|---|
| MiniLM-L6 | HuggingFace download (~80 MB) | None | — |
| BGE-Large | HuggingFace download (~1.3 GB) | None | — |
| GTE-Qwen2 | HuggingFace download (~1.5 GB) | None | — |
| **Cohere** | Key validation (1 request) | **Every embed call** | **Code chunks sent to Cohere API** |

If you choose Cohere, every code chunk is sent to `api.cohere.com` for embedding. Your API key is stored locally at `~/.wide-researcher/secrets.json` (mode 0600). The three local models never make network calls after the initial download.

For full details, see [docs/PRIVACY.md](docs/PRIVACY.md).

---

## Status & roadmap

**v0.1.0-alpha.24 — semantic + AST/symbol graph search.** A fresh machine can `npx wide-researcher init` today and end up with a working Claude Code integration. Existing projects can add graph payloads with `wide-researcher symbol-index` without rebuilding code vectors.

| Phase | What | Done |
|---|---|---|
| 1 | Repo bootstrap | ✅ |
| 2 | Python indexer (ts/tsx/py/go/rust/cs/json/md) | ✅ |
| 3 | Installers (qdrant + venv + model) | ✅ |
| 4 | Process supervision (systemd + launchd) | ✅ |
| 5 | Filesystem watcher daemon | ✅ |
| 6 | MCP server (wr_find / wr_file / wr_impact) | ✅ |
| 7 | Claude bundle (agent + skill + .mcp.json) | ✅ |
| 8 | CLI surface (init / add / reindex / status / search / uninstall) | ✅ |
| 9 | AST/symbol payload indexing for TS/TSX/C# | ✅ |
| 10 | Symbol-node Qdrant collection + `wr_symbol_find` | ✅ |
| 11 | Hybrid architecture impact + structural MCP tools | ✅ |
| 12 | Optional Neo4j sync/backend | ✅ |
| 13 | CI workflow + stable tagged release | pending |

### After v0.1

- Cross-encoder rerank for top-precision queries (~80 ms extra)
- Windows native process supervision
- Web UI for the impact diagram history
- Incremental model download (stream model weights instead of full download)
- LSP-backed exact type resolution beyond tree-sitter structural extraction

---

## Documentation

- **[docs/INSTALL.md](docs/INSTALL.md)** — prerequisites, install steps, troubleshooting per-OS
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — full data-flow diagram, why each design choice
- **[docs/PRIVACY.md](docs/PRIVACY.md)** — exhaustive network-call list, zero-telemetry claim, where your data lives
- **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)** — diagnostic commands, common failure modes

---

## Contributing

Issues + PRs welcome at [github.com/jaivial/wide-researcher](https://github.com/jaivial/wide-researcher).

Local development:

```bash
git clone https://github.com/jaivial/wide-researcher.git
cd wide-researcher
npm install
npm run build
node bin/wide-researcher.js --help
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev loop.

---

## License

MIT © 2026 jaivial. See [LICENSE](LICENSE).
