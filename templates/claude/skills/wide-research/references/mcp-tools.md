# wide-researcher MCP tools — full reference

## Collections

- Code chunks live in the configured Qdrant collection, for example `kraken_code`.
- AST/symbol nodes live in `${collection}_symbols`, for example `kraken_code_symbols`.
- `wr_arch_impact` combines both collections plus structural payload edges.

---

## `wr_arch_impact(description, k?)`

Hybrid architecture impact analysis. **Entry point for "what does this change affect" reasoning.**

### Signature

```ts
wr_arch_impact(args: {
  description: string;    // required — natural language
  k?: number;             // default 15, max files returned
}): Promise<ArchImpactFile[]>
```

### Algorithm

1. Run semantic/keyword hybrid search over code chunks.
2. Run symbol-node search over the symbol collection.
3. Extract seed files and symbols from both result sets.
4. Expand with structural edges:
   - callers: chunks where `calls` / `references` mention seed symbols
   - importers: chunks where `imports` / `imported_files` mention seed files/modules
   - exports: chunks where `exports` mention seed symbols
   - type users: chunks where `type_refs` / `base_types` / `implements` mention seed types
5. Merge and rank by semantic score, symbol-node score, structural edge weight, and derivative penalties.

### Returns

```ts
{
  file_path: string,
  language: string | null,
  role: string | null,
  score: number,
  reasons: string[],
  top_symbols: string[],
  edges: string[],
  source: 'semantic' | 'symbol' | 'caller' | 'importer' | 'type_relation' | 'export',
}[]
```

### Examples

```ts
// Scope a feature or bug fix
wr_arch_impact({ description: "workspace switch during article generation leaks articles", k: 20 })

// Find downstream blast radius
wr_arch_impact({ description: "change validateSession behavior", k: 25 })
```

---

## `wr_symbol_find(query, k?, kind?, lang?)`

Search AST/symbol nodes directly. Use for declarations, functions, classes, interfaces, React components, methods, and C# types.

### Signature

```ts
wr_symbol_find(args: {
  query: string;      // required
  k?: number;         // default 10
  kind?: string;      // function / class / interface / type / enum / method / const
  lang?: string;      // typescript / tsx / csharp
}): Promise<SymbolSearchResult[]>
```

### Returns

```ts
{
  node_id: string,
  kind: string,
  name: string,
  fqn: string | null,
  file_path: string,
  start_line: number,
  end_line: number,
  language: string,
  signature: string,
  calls: string[],
  imports: string[],
  exports: string[],
  score: number | null,
}[]
```

### Examples

```ts
// Find a function or component declaration
wr_symbol_find({ query: "validateSession", kind: "function" })

// Find C# methods
wr_symbol_find({ query: "GenerateViewerImageAsync", lang: "csharp", kind: "method" })

// Find React-ish symbols
wr_symbol_find({ query: "Workspace combobox", lang: "tsx" })
```

---

## `wr_callers(symbol, k?)`

Find chunks/files that call or reference a symbol. Use for "what calls X" and blast-radius checks.

### Signature

```ts
wr_callers(args: {
  symbol: string;   // required — exact or compact symbol name
  k?: number;       // default 20
}): Promise<SearchResult[]>
```

### Example

```ts
wr_callers({ symbol: "validateSession", k: 25 })
```

---

## `wr_callees(symbolOrFile, k?)`

Return calls made by matching chunks for a symbol name or file path.

### Signature

```ts
wr_callees(args: {
  symbolOrFile: string;  // symbol name or absolute file path
  k?: number;            // default 20
}): Promise<{ calls: string[]; chunks: SearchResult[] }>
```

### Example

```ts
wr_callees({ symbolOrFile: "/var/www/kraken/Dashboard/src/api/endpoints.ts" })
```

---

## `wr_importers(pathOrModule, k?)`

Find files that import a module string or resolved file path.

### Signature

```ts
wr_importers(args: {
  pathOrModule: string;  // import source, module name, or absolute file path
  k?: number;            // default 20
}): Promise<SearchResult[]>
```

### Examples

```ts
// Absolute file path
wr_importers({ pathOrModule: "/var/www/kraken/Dashboard/src/api/endpoints.ts" })

// Module specifier
wr_importers({ pathOrModule: "@/api/endpoints" })
```

---

## `wr_exports(path, k?)`

List exports declared by one file and return chunks carrying export payloads.

### Signature

```ts
wr_exports(args: {
  path: string;  // absolute file path
  k?: number;    // default 20
}): Promise<{ exports: string[]; chunks: SearchResult[] }>
```

### Example

```ts
wr_exports({ path: "/var/www/kraken/Dashboard/src/api/endpoints.ts" })
```

---

## `wr_find(query, k?, lang?, role?, layer?, mode?)`

Unified code chunk search. Three modes, one tool. Use after `wr_arch_impact` when you need chunk-level follow-up.

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
| `semantic` | Concept queries: "the login flow", "how we cap rate limits". |
| `keyword` | Literal identifiers: "useEffect", "QdrantClient", "ARTICLE_BATCH_TIMEOUT". |
| `hybrid` | **Default.** Qdrant native RRF fusion of both. |

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
  preview: string,
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

Fetch every indexed chunk of one file, ordered by `chunk_index`. Use after search/impact tools to read full structured content.

### Signature

```ts
wr_file(args: { path: string }): Promise<FileChunk[]>
```

`path` is the absolute path as stored in the index.

### Returns

Each chunk has full content:

```ts
{
  id: string,
  chunk_index: number,
  start_line: number,
  end_line: number,
  symbol_kind: string | null,
  symbol_name: string | null,
  language: string,
  role: string | null,
  content: string,
}
```

---

## `wr_impact(description, k?)`

Legacy file-grouped semantic impact analysis. Prefer `wr_arch_impact` when available.

### Signature

```ts
wr_impact(args: {
  description: string;
  k?: number;
}): Promise<ImpactFile[]>
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
  vector_size: number,
  distance: 'Cosine' | string,
}
```

Use it when:
- A search returns 0 results — is the collection green?
- After a long offline period — does `points_count` match expectations?
- Before bulk operations — is the indexer running cleanly?
