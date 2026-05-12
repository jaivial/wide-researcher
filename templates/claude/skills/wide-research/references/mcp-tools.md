# wide-researcher MCP tools — full reference

## `wr_find(query, k?, lang?, role?, layer?, mode?)`

Unified codebase search. Three modes, one tool.

### Signature

```ts
wr_find(args: {
  query: string;          // required
  k?: number;             // default 10
  lang?: string;          // typescript / tsx / python / go / rust / csharp / json / markdown / css / text
  role?: string;          // frontend / backend / docs / tests / config / stories / other
  layer?: string;         // atoms / ui / hooks / helpers / components / pages / layouts / api / signalr / locales / stories / types / constants
  mode?: 'semantic' | 'keyword' | 'hybrid';   // default 'hybrid'
}): Promise<SearchResult[]>
```

### Modes

| Mode | When |
|---|---|
| `semantic` | Concept queries. "the login flow", "how we cap rate limits". Vector similarity, MiniLM-L6 cosine. |
| `keyword` | Literal identifiers. "useEffect", "QdrantClient", "ARTICLE_BATCH_TIMEOUT". Full-text payload match. |
| `hybrid` | **Default.** Qdrant native RRF fusion of both. Picks up both kinds of hit in one round-trip. |

### Returns

Each result is a chunk-level hit:

```ts
{
  id: string,
  file_path: string,
  start_line: number,
  end_line: number,
  language: string,
  role: string | null,
  atomic_layer: string | null,
  symbol_kind: string | null,
  symbol_name: string | null,
  preview: string,        // first 500 chars of content
  score: number | null,
}
```

### Examples

```ts
// Concept search, frontend only
wr_find({ query: "session-cookie refresh logic", role: "frontend" })

// Literal symbol lookup
wr_find({ query: "QdrantClient", mode: "keyword" })

// Narrow to React atoms
wr_find({ query: "spinner component", layer: "atoms" })

// Cross-language, default hybrid
wr_find({ query: "rate limit middleware", k: 20 })
```

---

## `wr_file(path)`

Fetch every indexed chunk of one file, ordered by `chunk_index`.
Use after `wr_find` / `wr_impact` to read the full structured
content.

### Signature

```ts
wr_file(args: { path: string }): Promise<FileChunk[]>
```

`path` is the absolute path as stored in the index (the same string
that appears in `wr_find` results).

### Returns

Each chunk has full content (not preview):

```ts
{
  id: string,
  chunk_index: number,
  start_line: number,
  end_line: number,
  symbol_kind: string | null,    // function / class / interface / type / imports / block / …
  symbol_name: string | null,
  language: string,
  role: string | null,
  content: string,               // full text, no truncation
}
```

---

## `wr_impact(description, k?)`

File-grouped impact analysis. **The entry point for "what does this
change affect" reasoning.**

### Signature

```ts
wr_impact(args: {
  description: string;    // required — natural language
  k?: number;             // default 15, max files returned
}): Promise<ImpactFile[]>
```

### Algorithm

1. Hybrid search over a pool of **80 chunks** for the description.
2. Group hits by `file_path`.
3. Weight each chunk's score:
   - typescript / tsx / python / go / rust / csharp / java → 1.0
   - css → 0.5
   - text → 0.6
   - markdown → 0.3
   - json (non-locales) → 0.2
   - **derivative penalties**: `.stories.tsx` → 0.3, `.spec/.test`
     → 0.5, anything under `/locales/` → 0.2
4. Sum into `total_score`, sort descending, take top-`k`.

### Returns

```ts
{
  file_path: string,
  language: string,
  role: string | null,
  total_score: number,
  chunk_count_in_results: number,
  top_symbols: string[],     // up to 3 distinct symbol names
}[]
```

---

## `wr_index_status`

Sanity check. No args.

### Returns

```ts
{
  collection: string,
  status: 'green' | 'yellow' | 'red',
  points_count: number,
  vector_size: number,       // 384 for MiniLM-L6
  distance: 'Cosine' | …,
}
```

Use it when:
- A search returns 0 results — is the collection green?
- After a long offline period — does `points_count` match expectations?
- Before bulk operations — is the indexer running cleanly?
