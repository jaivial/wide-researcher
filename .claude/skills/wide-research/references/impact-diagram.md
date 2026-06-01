# Impact diagram — how it's structured

The optional CLI tool `wide-researcher search` (and the standalone
`python -m scripts.wide_research --prompt "<task>"` command) writes
two artefacts per run:

- `<project>/.wide-researcher/runs/<slug>/research-context.json`
- `<project>/.wide-researcher/runs/<slug>/impact-diagram.html`

The JSON is what programmatic consumers (orchestrators, planners,
test agents) ingest. The HTML is what humans open in a browser.

## research-context.json shape

```json
{
  "planSlug": "wide-20260512-143028",
  "createdAt": "2026-05-12T14:30:28+00:00",
  "prompt": "<verbatim user description>",
  "researcher": "wide-researcher",
  "project": "myapp",
  "projectRoot": "/abs/path/to/myapp",
  "collection": "myapp_a1b2c3d4",
  "matchedFiles": [
    {
      "path": "/abs/path/.../file.ts",
      "language": "typescript",
      "matches": 5,
      "score": 1.832,
      "role": "frontend",
      "atomic_layer": "hooks",
      "top_symbols": ["useFoo", "useBar"],
      "line_hits": [[12, 45], [88, 102]],
      "sources": ["semantic", "keyword"]
    },
    …
  ],
  "candidateRoles": ["frontend", "backend"],
  "candidateLayers": ["hooks", "api", "atoms"],
  "flags": {
    "filesLikelyTouched": 18
  },
  "wideResearch": {
    "diagramPath": "/abs/.../impact-diagram.html",
    "topK": 20,
    "semanticHits": 60,
    "keywordHits": 24,
    "symbolHits": 12,
    "structuralEdges": 18
  }
}
```

## impact-diagram.html

Self-contained React-Flow diagram. Loads React + reactflow from
`esm.sh` at runtime — no build step, no bundler. Open in any modern
browser with network access.

### Visual structure

- **Origin node** (centre, blue) — the user's prompt.
- **File nodes** in **4 concentric rings**:
  - **Ring 0** (innermost, green) — direct semantic hits.
  - **Ring 1** (amber) — close cluster.
  - **Ring 2** (red) — adjacent cluster.
  - **Ring 3** (outermost, grey) — distant.
- **Edges** between nodes encode relationships:
  - Origin → file: edge thickness scales with ring (origin0 thickest).
  - File ↔ file: `proximity` (dashed) for nearest-ring neighbours,
    `neighbor` (light blue) for spatial overlap, `symbol` (green)
    for shared symbol names, `caller`, `importer`, `export`, and
    `type_relation` for AST/symbol graph evidence, `owner`/`role`
    (amber dashed) for shared role, `dir` (grey dotted) for same
    directory.

### How agents use it

- **Read-only.** Diagrams are for humans + downstream tools, never
  edited by agents.
- The path is in `research-context.json` under
  `wideResearch.diagramPath` — pass it along verbatim when handing
  off to a planner / orchestrator that wants visual context.
- **Don't summarise the diagram in prose.** The JSON has every fact
  the diagram has, in machine-readable form. Quote the JSON.
