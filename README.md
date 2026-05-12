# wide-researcher

[![npm version](https://img.shields.io/badge/npm-v0.1.0--alpha-blue.svg)](https://www.npmjs.com/package/wide-researcher)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](#requirements)
[![python](https://img.shields.io/badge/python-%3E%3D3.11-yellow.svg)](#requirements)

> Drop a local Qdrant-backed semantic code index into any project,
> and Claude Code gets three new MCP tools — `wr_find`, `wr_file`,
> `wr_impact` — for finding files by **meaning** instead of by
> literal regex.
>
> Plus an **impact-radius diagram** that ranks every file a task is
> likely to touch, grouped by ring, rendered as a standalone HTML
> page.
>
> One command sets it up. Indexes update automatically on save.
> Everything runs locally. No telemetry.

---

## One-line install

```bash
# In any project's root:
npx wide-researcher init
```

That single command:

1. Installs **Qdrant** v1.18 (native binary, no Docker) into
   `~/.wide-researcher/qdrant/`.
2. Downloads **MiniLM-L6** (~80 MB) into `~/.wide-researcher/models/`.
3. Bootstraps a Python venv at `~/.wide-researcher/venv/` with the
   indexer dependencies.
4. Registers a `systemd --user` unit (Linux) or `launchd` plist
   (macOS) so Qdrant + the file watcher survive reboots.
5. Drops a project-scoped Claude Code agent + skill into
   `<project>/.claude/`.
6. Runs the initial full-codebase index. Time scales with codebase
   size — a 5 000-file repo takes about 5 minutes on a laptop.

After `init`, **edit any file and the index updates automatically.**

### Adding a second project

If `init` has already run on this machine, dropping wide-researcher
into another project is a single command that skips the global infra:

```bash
# In the new project's root:
npx wide-researcher add
```

---

## What you get inside Claude Code

Three MCP tools become available the moment Claude opens the project:

| Tool | What it does |
|---|---|
| `wr_find(query, mode?, lang?, role?, layer?)` | Chunk-level semantic / keyword / hybrid search. Hybrid mode = Qdrant native RRF fusion. |
| `wr_file(path)` | All chunks for one file, ordered. Full content, not preview. |
| `wr_impact(description, k?)` | File-grouped impact analysis. Weighted scoring, top-3 symbol names per file. **The go-to tool for "what does this change affect" reasoning.** |
| `wr_index_status` | Collection health (green/yellow/red) + counts. |

Plus a project-scoped **agent** (`.claude/agents/wide-researcher.md`)
that wraps the tools into a 4-step workflow:

1. `wr_impact` for the file-level ring grouping
2. `wr_file` for drill-down into specific files
3. `wr_find` for concept lookups
4. Synthesise a structured ring-grouped report

---

## CLI surface

```
wide-researcher init                 first-time setup on this machine
wide-researcher add                  add to a new project (skip global)
wide-researcher reindex              incremental reindex
wide-researcher reindex --force      full rebuild
wide-researcher status               qdrant + indexer + last-index time
wide-researcher status --json        machine-readable
wide-researcher search "<query>"     terminal-side smoke search
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
                          │ MCP tool call: wr_find / wr_file /
                          │ wr_impact / wr_index_status
                          ▼
        ┌────────────────────────────────────────────────────┐
        │  wide-researcher-mcp (Node, stdio transport)       │
        │  spawned by `<project>/.mcp.json`                  │
        └───────────────┬──────────────┬─────────────────────┘
                        │              │
                        │ Qdrant REST  │ Python subprocess
                        │              │ (embed worker)
                        ▼              ▼
            ┌─────────────────┐  ┌─────────────────┐
            │ Qdrant 1.18     │  │ MiniLM-L6       │
            │ 127.0.0.1:6333  │  │ sentence-       │
            │ HNSW + payload  │  │ transformers    │
            │ indexes         │  │ (PyTorch, 2 CPU)│
            └────────┬────────┘  └─────────────────┘
                     │
                     ▼
            ┌─────────────────┐
            │ per-project     │
            │ collection      │
            │ <name>_<sha1>   │
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
    ├── config.json                   ← collection name, paths, ignores
    └── runs/<slug>/                  ← research-context.json + diagram
```

### Global paths

```
~/.wide-researcher/
├── qdrant/                           ← native binary + storage
│   ├── qdrant
│   ├── config.yaml
│   └── storage/                      ← every project's collection
├── models/all-MiniLM-L6-v2/          ← embed model weights
├── venv/                             ← python deps
└── logs/                             ← per-project indexer logs
```

---

## Requirements

- **Linux** (any modern distro with `systemd --user`) or
  **macOS** (10.15+) or **Windows 10/11** (x86_64)
- **Node.js** 20+
- **Python** 3.11+
- **~200 MB free disk** for Qdrant + model

**Windows note:** v0.1 supports native Windows for everything except
process supervision. Qdrant binary, Python venv, embed model, MCP
server, Claude bundle, and the impact-diagram hook all install and
run natively. The systemd / launchd auto-start daemons are not yet
ported — Windows users run `qdrant.exe` and the indexer watcher
manually (or wrap with `nssm.exe` / Task Scheduler). Native auto-
start lands in v0.2.

---

## Privacy

`wide-researcher` is **100% local-first**. It does not phone home,
does not collect telemetry, never sends your code anywhere.

The only network calls are two **one-time downloads** at install:

| When | Where | Why |
|---|---|---|
| First `init` | github.com/qdrant/qdrant releases | Qdrant binary (~50 MB) |
| First `init` | huggingface.co/sentence-transformers | MiniLM-L6 weights (~80 MB) |

After install, **the package never opens an outbound connection
again.** The MCP server listens on `127.0.0.1` only.

See [docs/PRIVACY.md](docs/PRIVACY.md) for the full statement.

---

## Status & roadmap

**v0.1.0-alpha — functionally complete.** A fresh machine can
`npx wide-researcher init` today and end up with a fully working
Claude Code integration.

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
| 9 | Docs polish | ✅ |
| 10 | CI workflow + first tagged release | pending |

### After v0.1

- Cross-encoder rerank for top-precision queries (~80 ms extra)
- Optional Jina-v3 / bge-large embed model swap
- Windows native (currently WSL2 only)
- Web UI for the impact diagram history

---

## Documentation

- **[docs/INSTALL.md](docs/INSTALL.md)** — prerequisites, install
  steps, troubleshooting per-OS
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — full data-flow
  diagram, why each design choice
- **[docs/PRIVACY.md](docs/PRIVACY.md)** — exhaustive network-call
  list, zero-telemetry claim, where your data lives
- **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)** — diagnostic
  commands, common failure modes

---

## Contributing

Issues + PRs welcome at
[github.com/jaivial/wide-researcher](https://github.com/jaivial/wide-researcher).

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
