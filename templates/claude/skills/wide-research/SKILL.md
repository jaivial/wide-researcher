---
name: wide-research
description: Compute the impact radius of a coding task using the project's Qdrant semantic code index. Returns the ranked list of files likely to need edits with per-file reasoning, plus a path to a standalone HTML diagram. Use BEFORE planning multi-file changes, when scoping a task, or when answering "what does this affect". Triggers — "scope this task", "what does X affect", "where is Y", "find the files for Z", "wide research", "impact radius".
---

# wide-research skill

Compute the **impact radius** of a coding task: every file that
semantic-, keyword-, or side-effect-touches a description, ranked by
weighted score, grouped by ring (direct hit / close cluster /
adjacent / distant).

## When to invoke

- **Always** as the first step of a non-trivial task. Cheaper than
  reading 30 files to figure out what to read.
- When the user asks "where is X handled", "what affects Y", "scope
  this task", "find the files for Z".
- Before any multi-file edit, refactor, or feature work.

## How to invoke

The skill is implemented as **three MCP tools** that Claude Code
auto-discovers from `<project>/.mcp.json`. They appear in the tool
list under the `wide-researcher` server:

| Tool | When to use |
|---|---|
| `wr_impact(description, k?)` | **Entry point.** File-grouped impact analysis with weighted scoring. Default `k=15`. |
| `wr_find(query, k?, lang?, role?, layer?, mode?)` | Chunk-level search. Drill into a specific concept. Default `mode='hybrid'`. |
| `wr_file(path)` | Every chunk of one file, ordered. Use after `wr_find` / `wr_impact` to see full content. |
| `wr_index_status` | Sanity check the collection is healthy and up-to-date. |

## Filter cheat-sheet

`wr_find` accepts these payload filters (all optional):

- `lang` — `typescript` / `tsx` / `python` / `go` / `rust` / `csharp`
  / `json` / `markdown` / `css` / `text`
- `role` — `frontend` / `backend` / `docs` / `tests` / `config` /
  `stories` / `other`
- `layer` — atomic-design layer: `atoms` / `ui` / `hooks` / `helpers`
  / `components` / `pages` / `layouts` / `api` / `signalr` /
  `locales` / `stories` / `types` / `constants`

`mode`:
- `semantic` — vector similarity. Best for concepts ("login flow").
- `keyword` — full-text on payload. Best for literal identifiers
  ("useEffect", "QdrantClient").
- `hybrid` — Qdrant native RRF fusion. **Default. Recommended.**

## Output format

After collecting tool results, produce a structured report:

```
## Impact radius — <task summary>

**Ring 0 — direct hit (will almost certainly edit):**
- path/to/file.ts — <reason from wr_impact>
- …

**Ring 1 — close cluster:**
- …

**Ring 2 — adjacent:**
- …

**Cross-cutting concerns:**
- <i18n / tests / stories / boundary-crossing if applicable>
```

Quote file paths verbatim — downstream agents need exact strings.

## Hard rules

- **Use the MCP tools — do NOT grep the filesystem.** That defeats
  the whole point of having a semantic index.
- **Read-only.** Skill outputs are research artefacts, not edits.
  Edits are someone else's job.
- **`wr_impact` first, then `wr_find` for drill-downs.** Don't open
  with `wr_find` — you'll miss the file-level grouping.

## References

- `references/mcp-tools.md` — full tool reference + examples
- `references/impact-diagram.md` — how the diagram is structured
