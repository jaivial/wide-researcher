# Install

## Prerequisites

| Requirement | Minimum | Recommended |
|---|---|---|
| OS | Linux (`systemd --user` available) or macOS 10.15+ | latest stable |
| Node.js | 20 | 20.x LTS |
| Python | 3.11 | 3.12+ |
| Free disk | ~200 MB | 1 GB headroom |
| RAM | 2 GB free | 4 GB+ |

**Windows is WSL2 only in v0.1.** Native Windows is roadmap.

### Verifying prerequisites

```bash
node --version            # >= v20
python3 --version         # >= 3.11
systemctl --user --version 2>/dev/null && echo "systemd --user OK"   # Linux
launchctl version         # macOS
```

If `python3 --version` is below 3.11:

```bash
# Debian / Ubuntu
sudo apt install python3.11 python3.11-venv

# macOS (Homebrew)
brew install python@3.11

# Arch
sudo pacman -S python python-virtualenv
```

---

## One-line install

```bash
# In any project's root:
npx wide-researcher init
```

That command runs **six idempotent steps**:

1. **Global infra — Qdrant + venv + model + supervisor.** Downloads
   the Qdrant 1.18 binary for your host triple, creates a Python
   venv at `~/.wide-researcher/venv/`, downloads MiniLM-L6
   (~80 MB), registers `qdrant.service` under
   `systemctl --user` (or a LaunchAgent on macOS).
2. **Project identity + config.** Derives a deterministic slug =
   `<sanitised-basename>_<sha1(abs-path)[0:8]>` and writes
   `<project>/.wide-researcher/config.json`.
3. **Claude bundle.** Drops the agent + skill into
   `<project>/.claude/`, appends an MCP stanza to
   `<project>/.mcp.json` (preserving any other servers).
4. **Bootstrap the Qdrant collection.** HNSW (m=16, ef=128, cosine)
   + payload indexes (`file_path`, `role`, `language`, etc. as
   KEYWORD; `content`, `symbol_name` as TEXT for BM25).
5. **Initial reindex.** Walks the project, chunks each file
   (AST-aware), embeds, upserts. Progress bar in the terminal.
6. **Indexer watcher daemon.** Registers
   `wide-researcher-indexer-<slug>.service` so saves auto-index.

Each step is **idempotent** — re-running `init` is a no-op when
everything is already healthy. Use `--force` to re-do every step.

### Flag reference

| Flag | Effect |
|---|---|
| `--force` | Re-run every step regardless of current state |
| `--no-watch` | Skip the indexer watcher daemon (manual reindex only) |
| `--no-supervisor` | Skip ALL systemd/launchd registration (containers / CI) |
| `--no-reindex` | Skip the initial reindex (smoke tests only) |

### Adding to a second project on the same machine

```bash
npx wide-researcher add
```

Skips step 1 (global infra is already there). Steps 2-6 only.

---

## Verifying the install

```bash
wide-researcher status
```

Healthy output:

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
```

Smoke-search to confirm the embeddings are queryable:

```bash
wide-researcher search "your project's most-edited symbol"
```

---

## Troubleshooting

### `Error: python3.11 not found`

Install via your system package manager (see Prerequisites above).
`wide-researcher` does NOT bundle Python — it relies on a system
install.

### `Port 6333 already in use`

Another Qdrant or service is bound. Two options:

1. Stop the other service.
2. Point wide-researcher at a different port:

   ```bash
   # Currently requires hand-editing
   #   ~/.wide-researcher/qdrant/config.yaml  →  service.http_port: 6334
   #   <project>/.wide-researcher/config.json →  "qdrant_url": "http://127.0.0.1:6334"
   # Then:
   wide-researcher uninstall --all
   wide-researcher init --qdrant-port 6334    # flag landing in v0.2
   ```

### `systemd --user` not available (container / CI)

Use the `--no-supervisor` flag and start the daemons by hand:

```bash
# Foreground qdrant (background it however you want)
~/.wide-researcher/qdrant/qdrant \
  --config-path ~/.wide-researcher/qdrant/config.yaml &

# Foreground watcher
WIDE_RESEARCHER_PROJECT_CONFIG=/abs/path/.wide-researcher/config.json \
  ~/.wide-researcher/venv/bin/python -m scripts.watcher --verbose &
```

### Indexer service won't start

```bash
# Linux
journalctl --user -u wide-researcher-indexer-<slug>.service -n 100 --no-pager

# macOS
launchctl print gui/$UID/com.wide-researcher.indexer.<slug>
tail ~/.wide-researcher/logs/indexer-<slug>.log
```

Common cause: the `WIDE_RESEARCHER_PROJECT_CONFIG` path in the unit
file is stale (project moved). Re-run `wide-researcher add --force`.

### `0 results` from every search

Collection is empty. Force a fresh reindex:

```bash
wide-researcher reindex --force
```

If that errors with `Collection 'xxx' doesn't exist`, the
bootstrap step didn't run:

```bash
WIDE_RESEARCHER_PROJECT_CONFIG=/abs/path/.wide-researcher/config.json \
  ~/.wide-researcher/venv/bin/python -m scripts.init_collection
```

### Reinstall from scratch

```bash
wide-researcher uninstall --all
rm -rf ~/.wide-researcher
```

Then re-run `npx wide-researcher init`.

---

## See also

- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — how the pieces fit together
- [docs/PRIVACY.md](PRIVACY.md) — what leaves your machine (almost nothing)
- [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md) — deeper failure modes
