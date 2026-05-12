# Architecture

> Stub — fleshed out in Phase 9.

## High-level data flow

```
            ┌─────────────────────────────────┐
            │  Claude Code (in your project)  │
            └─────────────────┬───────────────┘
                              │ MCP tool call
                              │ wr_find / wr_impact / wr_file
                              ▼
                ┌───────────────────────────┐
                │   wr MCP server (Node)    │
                │   ─ stdio transport ─     │
                └─────────────┬─────────────┘
                              │ Qdrant REST
                              ▼
                ┌───────────────────────────┐
                │   Qdrant (local binary)   │
                │   127.0.0.1:6333          │
                └─────────────┬─────────────┘
                              │ vector search
                              │ (cosine, MiniLM-L6 384-d)
                              ▼
              ┌─────────────────────────────┐
              │   per-project collection    │
              │   <slug>_<sha1[0:8]>        │
              └─────────────────────────────┘

                  ┌──────────────────┐
   filesystem ───▶│ watcher daemon   │──▶ subprocess embed worker
   change        │ (Python watchdog)│    (sentence-transformers)
                  └──────────────────┘           │
                                                 ▼
                                       writes to Qdrant
```

## Per-project paths

```
<your-project>/
├── .claude/
│   ├── agents/wide-researcher.md     ← agent
│   └── skills/wide-research/         ← skill + references
├── .mcp.json                         ← appended with the wr MCP stanza
└── .wide-researcher/
    ├── config.json                   ← collection name, ignores, watch paths
    └── mcp-config.json               ← arg for the MCP server
```

## Global paths

```
~/.wide-researcher/
├── qdrant/
│   ├── qdrant                        ← native binary
│   ├── config.yaml                   ← storage dir, port, log level
│   └── storage/                      ← ALL collections live here
├── models/
│   └── all-MiniLM-L6-v2/             ← model weights
├── venv/                             ← python deps
├── scripts/                          ← watcher.py, embed_worker.py
└── logs/
    └── <project-slug>.log            ← per-project indexer logs
```

## Why this shape

- **One Qdrant for the machine, one collection per project** — keeps
  storage small (no duplicate index dirs) and means the user only
  pays the install cost once.
- **Native binary, no Docker** — avoids the runtime tax of a
  container for what is effectively a single sidecar process. Qdrant
  ships a small, portable binary.
- **CPU-only MiniLM** — works on every laptop, no GPU required.
  ~384-dimensional embeddings, ~50 ms/chunk on a single core.
- **Subprocess embed worker** — `sentence-transformers` leaks RAM
  slowly. Spawning a fresh worker per file (with a small batch
  size) survives indexing repos with >50 k files.
- **MCP over stdio** — Claude Code spawns the MCP server as a child
  process per session, scoped to the project via `.mcp.json`. Nothing
  listens on a TCP port for incoming Claude traffic.
