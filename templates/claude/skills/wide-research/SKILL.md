---
name: wide-research
description: Compute the impact radius of a coding task using the project's Qdrant semantic code index plus AST/symbol graph index. Returns ranked files likely to need edits with semantic, symbol, caller, importer, export, and type-relation reasoning, plus a path to a standalone HTML diagram. Use BEFORE planning multi-file changes, when scoping a task, or when answering "what does this affect". Triggers — "scope this task", "what does X affect", "where is Y", "what calls Y", "who imports Z", "find the files for Z", "wide research", "impact radius".
---

# wide-research skill

Compute the **impact radius** of a coding task: every file that
semantic-, keyword-, AST-symbol-, caller-, importer-, export-, or
type-relation-touches a description, ranked by weighted score and
grouped by ring (direct hit / structural neighbour / adjacent /
distant).

## When to invoke

- **Always** as the first step of a non-trivial task. Cheaper than
  reading 30 files to figure out what to read.
- When the user asks "where is X handled", "what calls Y", "who imports
  Z", "what affects Y", "scope this task", "find the files for Z".
- Before any multi-file edit, refactor, or feature work.

## How to invoke

The skill is implemented as **wide-researcher MCP tools** that Claude
Code auto-discovers from `<project>/.mcp.json`. They appear in the tool
list under the `wide-researcher` server:

| Tool | When to use |
|---|---|
| `wr_arch_impact(description, k?)` | **Entry point.** Hybrid semantic + AST/symbol graph impact analysis. Default `k=15`. |
| `wr_symbol_find(query, k?, kind?, lang?)` | Find declarations/symbol nodes: functions, classes, interfaces, components, methods. |
| `wr_callers(symbol, k?)` | Find chunks/files that call or reference a symbol. |
| `wr_callees(symbolOrFile, k?)` | Find calls made by a symbol or file. |
| `wr_importers(pathOrModule, k?)` | Find files importing a path or module. |
| `wr_exports(path, k?)` | List exports declared by a file. |
| `wr_find(query, k?, lang?, role?, layer?, mode?)` | Chunk-level search. Drill into a concept. Default `mode='hybrid'`. |
| `wr_file(path)` | Every chunk of one file, ordered. Use after search/impact tools to see full content. |
| `wr_impact(description, k?)` | Legacy semantic file-grouped impact analysis. Use only when graph impact is unavailable. |
| `wr_index_status` | Sanity check collections are healthy and up-to-date. |
| `wr_skill_find(query, k?, skill?, scope?, file_kind?)` | Hybrid search over the `<collection>_skills` Qdrant collection (SKILL.md / agents / references). Use to find the right skill before authoring new ones or to recall what a project/global skill does. |
| `wr_skill_add({path? \| content?, skill_name?, description?, trigger?, file_kind?, scope?})` | Add a markdown document to the skills collection. Pass `path` for a file/dir under `<project>/.claude/` or `~/.claude/`, or `content` for inline markdown. Idempotent on re-add. |

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
- path/to/file.ts — <semantic/symbol/caller/importer/type reason>
- …

**Ring 1 — structural neighbours:**
- …

**Ring 2 — adjacent:**
- …

**Cross-cutting concerns:**
- <i18n / tests / stories / boundary-crossing if applicable>
```

Quote file paths, symbol names, and edge reasons verbatim — downstream
agents need exact strings.

## Hard rules

- **MCP tools for code-content search ONLY — NEVER raw grep / find /
  Grep / Glob / Bash search on `.ts` / `.tsx` / `.cs` / `.py` /
  `.go` / `.rs` / `.java` / `.kt` source content.** The qdrant index
  is warm-latency, hybrid semantic+BM25, AST/symbol-aware. Raw grep
  over a multi-GB tree is slower AND misses semantic and graph hits.
- **Bash / Grep / Glob / find ARE allowed for: git ops, file metadata
  (size, mtime), config inspection (package.json, tsconfig, .env),
  log scans, systemd / process checks.** Just never on source content.
- **Read-only.** Skill outputs are research artefacts, not edits.
- **`wr_arch_impact` first, then structural drill-downs.** Don't open
  with `wr_find` — you'll miss file-level graph expansion.
- **Use the exact structural tool for exact structural questions:**
  `wr_callers` for "what calls X", `wr_importers` for "who imports Y",
  `wr_symbol_find` for declarations, `wr_exports` for file API.
- **If a deferred-tool error appears for any `mcp__wide-researcher__*`
  tool**, then call ToolSearch with
  `select:mcp__wide-researcher__wr_arch_impact,mcp__wide-researcher__wr_symbol_find,mcp__wide-researcher__wr_callers,mcp__wide-researcher__wr_importers,mcp__wide-researcher__wr_find,mcp__wide-researcher__wr_file`
  to load the schemas, then retry.

## References

- `references/mcp-tools.md` — full tool reference + examples
- `references/impact-diagram.md` — how the diagram is structured
