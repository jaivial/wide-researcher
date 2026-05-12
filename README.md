# wide-researcher

> Qdrant-backed semantic code-search + impact-radius diagrams, dropped
> into any project as a Claude Code MCP server with a single command.

`wide-researcher` indexes your codebase into a local Qdrant vector
database, watches the filesystem for changes, and exposes three MCP
tools to Claude Code so the model can find files by meaning instead
of by literal regex. When you give Claude a task description, it can
compute the **impact radius** — every file that semantic-, keyword-,
or side-effect-touches the task — and render it as a standalone HTML
diagram with concentric rings and connecting edges.

Everything runs locally. No telemetry. No data leaves your machine.

---

## Quickstart

```bash
# In any project's root:
npx wide-researcher init
```

That single command:

1. Installs **Qdrant** (native binary, no Docker) into
   `~/.wide-researcher/qdrant/` if not already present.
2. Downloads the **MiniLM-L6 embed model** into
   `~/.wide-researcher/models/` (~80 MB, one-time).
3. Bootstraps a Python venv at `~/.wide-researcher/venv/` with the
   indexer dependencies.
4. Registers a `systemd --user` unit (Linux) or `launchd` plist
   (macOS) so Qdrant + the file-watcher daemon survive reboots.
5. Drops a project-scoped Claude Code agent + skill into
   `<your-project>/.claude/` so the MCP tools auto-discover.
6. Runs the initial full-codebase index.

After that, **edit any file and the index updates automatically**.

### Adding a second project

If you've already run `init` once, dropping wide-researcher into
another project is a single command:

```bash
# In the new project's root:
npx wide-researcher add
```

Skips the global infra (Qdrant, model, venv) — only does the
per-project bits and kicks off the initial index.

---

## What you get inside Claude Code

Three MCP tools become available the moment Claude opens the project:

| Tool | What it does |
|---|---|
| `wr_find(query, mode="hybrid")` | Semantic + keyword hit list, ranked by score. |
| `wr_impact(description)` | Full impact-radius report — every file the task is likely to touch, grouped by ring (direct hit / close cluster / adjacent / distant), with reasoning per file. |
| `wr_file(path)` | All chunks for a single file — useful when Claude wants the full context of a hit. |

Plus a project-scoped slash command:

```
/wide-research <task description>
```

Renders the **impact-diagram HTML** (interactive React Flow graph) for
the task — origin prompt in the centre, file cards in concentric
rings, connecting edges showing semantic / keyword / shared-owner /
shared-symbol relationships.

---

## CLI surface

```
wide-researcher init                first-time setup on this machine
wide-researcher add                 add to a new project (skip global)
wide-researcher reindex             force a full reindex of the current project
wide-researcher status              qdrant + indexer + last-index time
wide-researcher search "<query>"    terminal-side smoke search
wide-researcher uninstall           remove from this project (--all to nuke global)
```

---

## Architecture

```
your-project/
├── .claude/
│   ├── agents/wide-researcher.md     ← agent that drives the skill
│   └── skills/wide-research/         ← skill + reference docs
└── .wide-researcher/
    ├── config.json                   ← collection name, watch paths, ignores
    └── mcp-config.json               ← MCP server stanza for .mcp.json

~/.wide-researcher/                   ← global, shared across projects
├── qdrant/                           ← native binary + storage
├── models/all-MiniLM-L6-v2/          ← embed model
├── venv/                             ← python deps
└── logs/                             ← per-project indexer logs
```

The **MCP server** is a thin Node.js wrapper that translates
Claude's tool calls into Qdrant REST queries against the
per-project collection (named `<project>_<sha1[0:8]>`, guaranteed
unique). The **indexer daemon** watches the filesystem with
`watchdog`, debounces 1.5 s, and re-embeds changed files in a
subprocess so RAM never spikes.

---

## Requirements

- **Linux** (any modern distro) or **macOS** (10.15+)
- **Node.js** 20+
- **Python** 3.11+
- **~200 MB free disk** for Qdrant + model

Windows: WSL2 only (native Windows is on the roadmap).

---

## Privacy

`wide-researcher` is **100% local-first**. It does not phone home,
does not collect telemetry, and never sends your code anywhere. The
only network calls are:

- One-time download of the Qdrant binary from
  [github.com/qdrant/qdrant releases](https://github.com/qdrant/qdrant/releases).
- One-time download of the MiniLM-L6 model from
  [huggingface.co/sentence-transformers](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2).

After install, the network is never touched again.

See [docs/PRIVACY.md](docs/PRIVACY.md).

---

## Status

🚧 **Alpha** — currently scaffolding. See
[ROADMAP.md](#roadmap) below for the phase plan.

### Roadmap

- [x] Phase 1 — Repo bootstrap (this commit)
- [ ] Phase 2 — Lift the Python indexer
- [ ] Phase 3 — Installers (Qdrant + model + venv)
- [ ] Phase 4 — Process supervision (systemd + launchd)
- [ ] Phase 5 — Watcher daemon
- [ ] Phase 6 — MCP server
- [ ] Phase 7 — Claude bundle (agent + skill templates)
- [ ] Phase 8 — CLI surface (`init` / `add` / `reindex` / ...)
- [ ] Phase 9 — Docs (INSTALL / ARCHITECTURE / PRIVACY / TROUBLESHOOTING)
- [ ] Phase 10 — CI + first tagged release (v0.1.0)

---

## Contributing

Issues + PRs welcome at
[github.com/jaivial/wide-researcher](https://github.com/jaivial/wide-researcher).

## License

MIT © 2026 jaivial. See [LICENSE](LICENSE).
