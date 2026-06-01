# Architecture

## High-level data flow

```
            ┌──────────────────────────────────────────────┐
            │  Claude Code (in your project, MCP-aware)    │
            └─────────────────┬────────────────────────────┘
                              │ MCP tool call:
                              │   wr_find / wr_file /
                              │   wr_call_args / wr_impact /
                              │   wr_index_status
                              ▼
               ┌──────────────────────────────────┐
               │  wide-researcher-mcp (Node)      │
               │  stdio transport · spawned by    │
               │  <project>/.mcp.json             │
               └──┬───────────────────────┬───────┘
                  │                       │
                  │ Qdrant REST           │ stdio JSON-line
                  │                       │ {"op":"embed",
                  ▼                       │  "text":"…"}
       ┌─────────────────┐                ▼
       │ Qdrant 1.18     │      ┌──────────────────────┐
       │ 127.0.0.1:6333  │      │ embed_worker.py      │
       │ HNSW(m=16,      │      │ (Python subprocess,  │
       │  ef=128)        │      │  MiniLM-L6, PyTorch) │
       │ cosine · 384-d  │      │ 2 CPU cores capped   │
       └────────┬────────┘      └──────────────────────┘
                │
                ▼
       ┌─────────────────┐
       │ per-project     │
       │ collection      │
       │ <name>_<sha1>   │
       │ payload TEXT    │
       │ indexes for BM25│
       └─────────────────┘

         ┌──────────────────────────────────────────────┐
         │  filesystem watcher daemon                   │
         │  (Python · watchdog · 1.5 s debounce)        │
         │  spawned by systemd/launchd                  │
         └────────────────────┬─────────────────────────┘
                              │
                              │ on save:
                              │   `python -m indexer file <path>`
                              │   in a fresh subprocess
                              │   (RAM safety — see below)
                              ▼
                         (Qdrant above)
```

## MCP result shaping and literal enumeration

MCP responses are compact by default. `wr_find` returns bounded snippets,
line/content counts, match reasons, and warning metadata instead of full
chunk bodies. Use `include_code_lines=true` or paginated `wr_file` only
for targeted follow-up reads. The server applies a final serialized byte
budget (`WIDE_RESEARCHER_MAX_RESPONSE_BYTES`, default 64 KiB) so a broad
query cannot flood the client with tens of thousands of lines.

Use the tools by intent:

- `wr_impact` / `wr_find` — first-pass targeting and discovery.
- `wr_call_args` — precise literal argument enumeration, e.g.
  `callee=atomWithStorage argIndex=0` for storage-key discovery.
- `wr_file` — paginated chunk inspection after a file has been located.

TypeScript/TSX indexing records call-site literals in chunk payloads:
`call_arg_literals`, `storage_keys`, `call_sites`, and `callsite_text`.
This makes multi-line calls searchable without relying on oversized code
snippets or shell grep.

## Three running processes

| Process | What | Where | Lifecycle |
|---|---|---|---|
| `qdrant` | Vector DB + payload-index server | `~/.wide-researcher/qdrant/qdrant` | systemd `--user` unit / LaunchAgent · machine-wide singleton |
| `python -m scripts.watcher` | Filesystem watcher + reindex dispatcher | `~/.wide-researcher/venv/bin/python` | `wide-researcher-indexer-<slug>.service` per project |
| `wide-researcher-mcp` | Stdio MCP server | `bin/wide-researcher-mcp.js` (node) | spawned per Claude session by `.mcp.json` |

The MCP server is **on-demand only** — it lives for the lifetime of
a Claude Code session and exits with it. qdrant + the watcher are
long-running daemons.

## Per-project paths

```
<your-project>/
├── .claude/
│   ├── agents/wide-researcher.md     ← agent definition
│   └── skills/wide-research/         ← skill + references
├── .mcp.json                         ← MCP server stanza
└── .wide-researcher/
    ├── config.json                   ← the JSON every component reads
    ├── .file_index.json              ← file→hash sidecar (incremental)
    └── runs/<slug>/                  ← research-context.json + diagram
        ├── research-context.json
        └── impact-diagram.html
```

## Global paths

```
~/.wide-researcher/
├── qdrant/
│   ├── qdrant                        ← native binary, v1.18
│   ├── config.yaml                   ← storage dir, port, 127.0.0.1 only
│   └── storage/                      ← ALL projects' collections live here
├── models/
│   └── all-MiniLM-L6-v2/             ← ~80 MB of model weights
├── venv/                             ← python 3.11+ + indexer deps
└── logs/
    ├── qdrant.log
    └── indexer-<slug>.log            ← one per project
```

## Why each choice

### Qdrant native binary, not Docker

Qdrant ships a small portable binary. Docker adds a runtime tax,
needs root for daemon-mode, complicates `systemd --user` integration,
and offers zero benefit for a single-user local-only DB.

### One Qdrant for the machine, one collection per project

Storage stays small (no duplicate index dirs). The user pays the
install cost once. Collections are isolated by name —
`<sanitised-basename>_<sha1(abs-path)[0:8]>` is unique per absolute
path even if two repos share a basename.

### MiniLM-L6 (384-d, CPU-only)

- Tiny (~80 MB on disk).
- Works on every laptop — no GPU required.
- ~50 ms/chunk on a single core; ~22 ms with PyTorch's intra-op
  parallelism.
- Quality: matches BGE-small for code retrieval and beats it on
  multilingual code-comment queries.

We tried fastembed (ONNX runtime) for speed. It leaked ~180 MB per
file on long-running workloads and OOMed the indexer after ~65
files. PyTorch is ~2× slower per embed but stable for hours.

### Subprocess-per-file for the watcher

`sentence-transformers` leaks small amounts of memory per batch.
A long-running daemon that keeps the model loaded climbs to
12+ GB RSS after a day of active editing. The watcher spawns a
fresh `python -m indexer file <path>` per debounce batch instead,
which gives the kernel a clean reclamation opportunity after each
save. Trade-off: ~1 s import overhead per re-embed.

### `systemd --user` (not system-wide)

- No root required.
- Resource caps (`CPUQuota=200%`, `MemoryMax=4G`) apply per-user.
- Logs go to the user's journal, not the system journal.
- Survives logout (with `loginctl enable-linger`); doesn't survive
  reboot unless lingering is enabled (which is fine — Qdrant
  auto-bootstraps on next login).

### `tree-sitter-languages` for AST chunking

Single-package install with grammars for every language we ship
(ts/tsx/python/go/rust/csharp). Fallback to line-chunking for any
text type we don't have an AST for. Markdown gets a heading-based
chunker; JSON locales get a key-based chunker.

### Hybrid search default = Qdrant native RRF

One round-trip, no client-side fusion code, no separate query
manager. Qdrant's `prefetch` + `query: {fusion: 'rrf'}` fuses a
vector-search prefetch with a full-text-match prefetch on the
`content` payload index. Beats either mode alone for code queries
that mix concepts with literal identifiers.

## Performance notes

| Operation | Typical time |
|---|---|
| Initial index (5 000 files) | ~5 min |
| Initial index (50 000 files) | ~45-60 min |
| `wr_find` (hybrid, top-10) | ~50-80 ms |
| `wr_impact` (k=15) | ~150-250 ms (wider pool) |
| `wr_file` (whole file, ~50 chunks) | ~10-20 ms |
| Watcher debounce flush | ~1 s import + 22 ms per chunk |

All measured on a 2024 MacBook Pro M3 Pro · CPU-only.
