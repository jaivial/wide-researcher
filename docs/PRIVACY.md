# Privacy

`wide-researcher` is **100% local-first**. By design, your code never
leaves your machine.

## Network calls — exhaustive list

The package makes exactly these outbound HTTP requests, ever:

| When | Where | What | Why |
|---|---|---|---|
| First-time `init` | `github.com/qdrant/qdrant/releases/...` | Qdrant binary tarball (~50 MB) | Install the vector DB. |
| First-time `init` | `huggingface.co/sentence-transformers/all-MiniLM-L6-v2/...` | Model weights (~80 MB) | Install the embed model. |

Both downloads are **content-addressed**: their hashes are checked
against a vendored manifest. Wide-researcher fails closed if a hash
mismatches.

After `init` completes, the package **never opens an outbound
connection again**. The MCP server listens only on the loopback
interface (`127.0.0.1`). The indexer daemon runs entirely local.

## Telemetry

**There is none.** No usage counts, no error reports, no anonymous
identifiers. The package contains zero analytics SDK code. You can
verify this by grepping the source: `grep -ri "fetch\\|http" src/`
returns only the install-time download calls.

## Where your data lives

| Data | Location |
|---|---|
| Indexed code chunks (embeddings + text) | `~/.wide-researcher/qdrant/storage/` |
| Indexer logs | `~/.wide-researcher/logs/<project-slug>.log` |
| Per-project config (no code) | `<your-project>/.wide-researcher/config.json` |

Uninstall with `wide-researcher uninstall --all` nukes every byte.

## Source code

The package is MIT-licensed and open-source at
[github.com/jaivial/wide-researcher](https://github.com/jaivial/wide-researcher).
Read or audit any part of it.

If you find a privacy issue, open a public GitHub issue or email the
maintainer (see `package.json` `author` field).
