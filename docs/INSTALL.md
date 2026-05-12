# Install

## Prerequisites

- **Linux** (any modern distro) or **macOS** (10.15 Catalina or newer)
- **Node.js** 20 or newer — `node --version`
- **Python** 3.11 or newer — `python3 --version`
- **~200 MB free disk** for Qdrant binary + MiniLM model

> Windows is **WSL2 only** in v0.1. Native Windows support is on the
> roadmap.

## One-line install

```bash
# In any project's root directory:
npx wide-researcher init
```

That's the whole install. The command is **idempotent** — running it
again is a no-op if everything is already in place.

What `init` does, in order:

1. **Detect or install Qdrant.** Downloads the native binary for your
   arch (`x86_64` or `aarch64`) from the upstream GitHub releases and
   extracts it to `~/.wide-researcher/qdrant/`. Writes a config that
   points the storage dir at `~/.wide-researcher/qdrant/storage/`.
2. **Detect or download the embed model.** Pulls
   `sentence-transformers/all-MiniLM-L6-v2` (~80 MB) into
   `~/.wide-researcher/models/all-MiniLM-L6-v2/` via
   `huggingface_hub`.
3. **Bootstrap a Python venv.** Creates `~/.wide-researcher/venv/`
   and installs `sentence-transformers`, `qdrant-client`,
   `tree-sitter`, `tree-sitter-languages`, `watchdog`.
4. **Register process supervision.**
   - Linux: `~/.config/systemd/user/qdrant.service` +
     `wide-researcher-indexer@<slug>.service` (CPU cap 200%, RAM
     cap 2 GB).
   - macOS: `~/Library/LaunchAgents/...plist` with `Nice` +
     `EnvironmentVariables` for the same effective caps.
5. **Drop the Claude bundle.** Copies the agent + skill templates
   into `<your-project>/.claude/agents/` and `<your-project>/.claude/skills/`,
   and appends the MCP server stanza to `<your-project>/.mcp.json`
   (creating the file if absent).
6. **Run the initial index.** Progress bar in the terminal. Time
   scales with codebase size — a 5 000-file repo takes about 5
   minutes on a modern laptop.

## Adding a second project

If `init` has already run on this machine, dropping wide-researcher
into another project is a one-liner that skips the global infra:

```bash
# In the new project's root:
npx wide-researcher add
```

## Verifying the install

```bash
wide-researcher status
```

Expected output:

```
qdrant         ✓ running on http://127.0.0.1:6333
indexer        ✓ active (watching 1234 files)
last-index     2026-05-12 14:32:01 (3m ago)
collection     myproject_a1b2c3d4 (12891 chunks)
```

## Troubleshooting

### `Error: python3.11 not found`

Install Python 3.11 via your system package manager:

```bash
# Debian/Ubuntu
sudo apt install python3.11 python3.11-venv

# macOS (Homebrew)
brew install python@3.11

# Arch
sudo pacman -S python python-virtualenv
```

### `Port 6333 already in use`

Wide-researcher detects this and falls back to `6334` automatically.
If you want a specific port:

```bash
npx wide-researcher init --qdrant-port 6335
```

### `systemd --user` is not available

Some container/server environments disable `systemd --user`. In that
case `init` falls back to a foreground daemon:

```bash
# Manual fallback (Linux without systemd --user)
~/.wide-researcher/venv/bin/python ~/.wide-researcher/scripts/watcher.py \
  --project /path/to/your/project &
```

### Resetting from scratch

```bash
wide-researcher uninstall --all
rm -rf ~/.wide-researcher
```

Then re-run `npx wide-researcher init`.

## See also

- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — how the pieces fit together
- [docs/PRIVACY.md](PRIVACY.md) — what leaves your machine (almost nothing)
- [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md) — deeper failure modes
