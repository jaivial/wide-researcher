# Troubleshooting

> Stub — fleshed out in Phase 9. See [INSTALL.md](INSTALL.md) for the
> common cases.

## Diagnostic commands

```bash
# Is everything healthy?
wide-researcher status

# Is the daemon actually running?
systemctl --user status qdrant
systemctl --user status wide-researcher-indexer@<slug>

# Tail the per-project indexer log
tail -f ~/.wide-researcher/logs/<project-slug>.log

# Manually trigger a reindex
wide-researcher reindex
```

## Common failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `wr_find` returns 0 results in Claude | Collection is empty | `wide-researcher reindex` |
| Indexer eats 100% CPU forever | Watch path includes `node_modules/` | Edit `.wide-researcher/config.json`, add to `exclude_globs` |
| `init` fails on `pip install` | Python version mismatch | `python3 --version` must be ≥ 3.11 |
| Qdrant binary won't start | ARM Mac on Rosetta vs native | Re-run `init` — auto-detects arch |
| MCP server times out in Claude | `.mcp.json` stanza missing or malformed | `cat <project>/.mcp.json` — should have a `wide-researcher` key |

## When to file an issue

If `wide-researcher status` shows all green but Claude still can't
see the tools, dump:

```bash
wide-researcher status --json > status.json
cat <project>/.mcp.json > mcp.json
tail -200 ~/.wide-researcher/logs/<project-slug>.log > indexer.log
```

…and open an issue at
[github.com/jaivial/wide-researcher/issues](https://github.com/jaivial/wide-researcher/issues)
with all three files attached.
