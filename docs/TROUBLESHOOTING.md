# Troubleshooting

Most issues are diagnosable with one command:

```bash
wide-researcher status
```

The table tells you which subsystem is unhealthy. Read the rest of
this doc to fix that subsystem.

---

## Diagnostic commands

```bash
# Everything at a glance
wide-researcher status
wide-researcher status --json | jq .

# Is qdrant alive?
curl -s http://127.0.0.1:6333/healthz
curl -s http://127.0.0.1:6333/collections | jq .

# Is the watcher daemon running?
systemctl --user status wide-researcher-indexer-<slug>.service       # Linux
launchctl print gui/$UID/com.wide-researcher.indexer.<slug>          # macOS

# Tail the per-project indexer log
tail -f ~/.wide-researcher/logs/indexer-<slug>.log

# Manually trigger a reindex
wide-researcher reindex --force

# Manually probe the embed model
~/.wide-researcher/venv/bin/python -c \
  "from sentence_transformers import SentenceTransformer; \
   m = SentenceTransformer('$HOME/.wide-researcher/models/all-MiniLM-L6-v2'); \
   print('OK', len(m.encode(['hello'])[0]))"
```

---

## Common failure modes

### `wr_find` returns 0 results in Claude

**Likely cause:** collection is empty (initial reindex failed or
was skipped).

**Fix:**
```bash
wide-researcher status         # confirm points = 0
wide-researcher reindex --force
```

If `reindex` errors with `Collection 'xxx' doesn't exist`:
```bash
WIDE_RESEARCHER_PROJECT_CONFIG=$PWD/.wide-researcher/config.json \
  ~/.wide-researcher/venv/bin/python -m scripts.init_collection
```

---

### Indexer service won't start

**Symptoms:** `status` shows `indexer: inactive` or
`indexer: failed`.

**Diagnose:**
```bash
# Linux
journalctl --user -u wide-researcher-indexer-<slug>.service -n 100 --no-pager

# macOS
tail -100 ~/.wide-researcher/logs/indexer-<slug>.log
```

**Common causes:**

1. **Project moved** — the unit file has the old absolute path
   baked in. Re-register:
   ```bash
   wide-researcher add --force
   ```

2. **Python venv broken** — the indexer can't import its deps:
   ```
   ModuleNotFoundError: No module named 'qdrant_client'
   ```
   Rebuild the venv:
   ```bash
   wide-researcher uninstall --all
   wide-researcher init
   ```

3. **Embed model missing** — model dir was deleted, venv is fine:
   ```
   OSError: Can't load tokenizer for '/home/u/.wide-researcher/models/all-MiniLM-L6-v2'
   ```
   Force redownload:
   ```bash
   ~/.wide-researcher/venv/bin/python -c \
     "from huggingface_hub import snapshot_download; \
      snapshot_download(repo_id='sentence-transformers/all-MiniLM-L6-v2', \
                        local_dir='$HOME/.wide-researcher/models/all-MiniLM-L6-v2')"
   ```

---

### Indexer eats 100% CPU forever

**Likely cause:** watch path includes a vendor / build / cache dir
the default excludes don't cover.

**Fix:** add to your project config's `exclude_dir_names`:

```jsonc
// <project>/.wide-researcher/config.json
{
  …,
  "exclude_dir_names": ["target", "vendor", "third_party", "generated"]
}
```

Then restart the watcher:
```bash
systemctl --user restart wide-researcher-indexer-<slug>.service   # Linux
launchctl kickstart -k gui/$UID/com.wide-researcher.indexer.<slug> # macOS
```

---

### `init` fails on `pip install`

**Likely cause:** Python version mismatch or missing build deps.

```bash
python3 --version       # must be >= 3.11
```

If `< 3.11`, install per your OS (see [INSTALL.md](INSTALL.md)).

If the failure is `Building wheel for torch ... error`, your CPU
has no AVX2. Pin to an older torch:
```bash
~/.wide-researcher/venv/bin/pip install 'torch==2.2.2'
```

---

### Qdrant binary won't start (ARM Mac)

`init` auto-detects ARM vs Intel. If you copied
`~/.wide-researcher/qdrant/` from another machine, the binary may
be for the wrong arch. Force re-download:

```bash
rm -rf ~/.wide-researcher/qdrant/qdrant
wide-researcher init --force
```

---

### `MCP server times out` in Claude

**Likely cause:** `.mcp.json` stanza references a stale path
(e.g. you reinstalled wide-researcher in a different location).

```bash
cat .mcp.json | jq '.mcpServers["wide-researcher"]'
```

Re-write the stanza:

```bash
wide-researcher add --force
```

Then restart Claude Code so it re-reads `.mcp.json`.

---

### Embeddings are wrong / index gives nonsense results

**Most likely cause:** the embed model dim changed between installs
(e.g. you swapped MiniLM for BGE manually). Qdrant won't reject —
it'll just silently produce garbage.

**Fix:** drop the collection and reindex:
```bash
wide-researcher uninstall --drop-collection
wide-researcher add
```

---

## Filing an issue

If `wide-researcher status` shows all green but Claude still can't
see the tools, dump these and attach to a new issue:

```bash
wide-researcher status --json > /tmp/wr-status.json
cat <project>/.mcp.json > /tmp/wr-mcp.json
tail -200 ~/.wide-researcher/logs/indexer-<slug>.log > /tmp/wr-indexer.log
tail -200 ~/.wide-researcher/logs/qdrant.log > /tmp/wr-qdrant.log

# Linux only — service-level diagnostics
journalctl --user -u qdrant.service -n 100 --no-pager > /tmp/wr-qdrant-svc.log
journalctl --user -u wide-researcher-indexer-<slug>.service -n 100 --no-pager > /tmp/wr-indexer-svc.log
```

Open the issue at
[github.com/jaivial/wide-researcher/issues](https://github.com/jaivial/wide-researcher/issues)
with all of those attached.
