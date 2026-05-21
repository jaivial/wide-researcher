// MCP tool implementations (Qdrant backend).
//
// Three public tools:
//   wr_find          — unified semantic / keyword / hybrid search
//   wr_file          — every chunk of a file
//   wr_impact        — file-grouped impact analysis
//   wr_index_status  — health + counts
//
// No legacy aliases — wide-researcher is a fresh project, no
// migration history to support.

import { qdrant, COLLECTION, PROJECT_CONFIG } from './db.js';
import {
  neo4jCallers,
  neo4jCallees,
  neo4jConfigError,
  neo4jEnabled,
  neo4jExports,
  neo4jImporters,
} from './neo4j.js';

type EmbedFn = (text: string) => Promise<number[]>;
const SYMBOL_COLLECTION = `${COLLECTION}_symbols`;

interface QdrantPoint {
  id: string | number;
  score?: number;
  payload?: Record<string, unknown> | null;
}

interface SearchResult {
  id: string | number;
  file_path?: string;
  start_line?: number;
  end_line?: number;
  language?: string;
  role?: string | null;
  atomic_layer?: string | null;
  symbol_kind?: string | null;
  symbol_name?: string | null;
  symbol_id?: string | null;
  symbol_fqn?: string | null;
  declared_symbols: string[];
  imports: string[];
  imported_files: string[];
  exports: string[];
  calls: string[];
  type_refs: string[];
  base_types: string[];
  implements: string[];
  references: string[];
  graph_text?: string;
  preview: string;
  code_lines: Array<{ line: number; text: string }>;
  score: number | null;
}

/* ── helpers ────────────────────────────────────────────────────────── */

interface FilterOpts {
  language?: string | null;
  role?: string | null;
  atomic_layer?: string | null;
}

function buildFilter(opts: FilterOpts): { must: Record<string, unknown>[] } | undefined {
  const must: Record<string, unknown>[] = [];
  if (opts.language) must.push({ key: 'language', match: { value: opts.language } });
  if (opts.role) must.push({ key: 'role', match: { value: opts.role } });
  if (opts.atomic_layer) {
    must.push({ key: 'atomic_layer', match: { value: opts.atomic_layer } });
  }
  return must.length ? { must } : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function payloadToResult(point: QdrantPoint): SearchResult {
  const p = (point.payload ?? {}) as Record<string, unknown>;
  const content = typeof p.content === 'string' ? p.content : '';
  const startLine = typeof p.start_line === 'number' ? p.start_line : 1;
  return {
    id: point.id,
    file_path: p.file_path as string | undefined,
    start_line: p.start_line as number | undefined,
    end_line: p.end_line as number | undefined,
    language: p.language as string | undefined,
    role: (p.role as string | null) ?? null,
    atomic_layer: (p.atomic_layer as string | null) ?? null,
    symbol_kind: (p.symbol_kind as string | null) ?? null,
    symbol_name: (p.symbol_name as string | null) ?? null,
    symbol_id: (p.symbol_id as string | null) ?? null,
    symbol_fqn: (p.symbol_fqn as string | null) ?? null,
    declared_symbols: asStringArray(p.declared_symbols),
    imports: asStringArray(p.imports),
    imported_files: asStringArray(p.imported_files),
    exports: asStringArray(p.exports),
    calls: asStringArray(p.calls),
    type_refs: asStringArray(p.type_refs),
    base_types: asStringArray(p.base_types),
    implements: asStringArray(p.implements),
    references: asStringArray(p.references),
    graph_text: typeof p.graph_text === 'string' ? p.graph_text : undefined,
    preview: content.slice(0, 500),
    code_lines: content.split(/\r?\n/).map((text, idx) => ({
      line: startLine + idx,
      text,
    })),
    score: point.score ?? null,
  };
}

const IMPACT_WEIGHT: Record<string, number> = {
  typescript: 1.0,
  tsx: 1.0,
  csharp: 1.0,
  python: 1.0,
  go: 1.0,
  rust: 1.0,
  json: 0.2,
  markdown: 0.3,
  css: 0.5,
  text: 0.6,
};

function impactWeight(language: string | undefined, filePath: string | undefined): number {
  if (filePath && filePath.endsWith('.stories.tsx')) return 0.3;
  if (filePath && /\.(spec|test)\.(ts|tsx)$/.test(filePath)) return 0.5;
  if (filePath && /(_test\.go|_test\.py|_spec\.rb)$/.test(filePath)) return 0.5;
  if (filePath && filePath.includes('/locales/')) return 0.2;
  return IMPACT_WEIGHT[language ?? ''] ?? 1.0;
}

/* ── search modes ───────────────────────────────────────────────────── */

interface ModeOpts {
  embed: EmbedFn;
  queryText: string;
  top_k: number;
  filter: ReturnType<typeof buildFilter>;
}

async function searchSemantic(opts: ModeOpts): Promise<SearchResult[]> {
  const vec = await opts.embed(opts.queryText);
  const res = (await qdrant.query(COLLECTION, {
    query: vec,
    limit: opts.top_k,
    filter: opts.filter,
    with_payload: true,
    params: { hnsw_ef: 128 },
  })) as { points?: QdrantPoint[] };
  return (res.points ?? []).map(payloadToResult);
}

async function searchKeyword(
  opts: Omit<ModeOpts, 'embed'>,
): Promise<SearchResult[]> {
  const must: Record<string, unknown>[] = [
    { key: 'content', match: { text: opts.queryText } },
  ];
  // keyword mode ignores role/atomic_layer — they were indexed inconsistently
  // (null in Qdrant, correct values in metadata) and filtering causes false negatives
  const res = (await qdrant.scroll(COLLECTION, {
    filter: { must },
    limit: opts.top_k,
    with_payload: true,
    with_vector: false,
  })) as { points?: QdrantPoint[] };
  return (res.points ?? []).map((pt) => ({
    ...payloadToResult(pt),
    score: 1.0,
  }));
}

async function searchHybrid(opts: ModeOpts): Promise<SearchResult[]> {
  const vec = await opts.embed(opts.queryText);
  const keywordMust: Record<string, unknown>[] = [
    { key: 'content', match: { text: opts.queryText } },
  ];
  // Filter semantic prefetch to language only — role/atomic_layer are null in DB
  // due to incomplete re-indexing, so filtering on them causes false negatives.
  const semanticFilter = opts.filter
    ? { must: opts.filter.must.filter(f => f.key === 'language') }
    : undefined;
  const res = (await qdrant.query(COLLECTION, {
    prefetch: [
      { query: vec, using: '', limit: opts.top_k * 4, filter: semanticFilter },
      { filter: { must: keywordMust }, limit: opts.top_k * 4 },
    ],
    query: { fusion: 'rrf' },
    limit: opts.top_k,
    with_payload: true,
  })) as { points?: QdrantPoint[] };
  return (res.points ?? []).map(payloadToResult);
}

/* ── graph helpers ──────────────────────────────────────────────────── */

function valueFilter(field: string, value: string): { must: Record<string, unknown>[] } {
  return { must: [{ key: field, match: { value } }] };
}

function anyValueFilter(fields: string[], value: string): { should: Record<string, unknown>[] } {
  return { should: fields.map((field) => ({ key: field, match: { value } })) };
}

async function scrollCollection(
  collection: string,
  filter: Record<string, unknown>,
  limit: number,
): Promise<QdrantPoint[]> {
  const res = (await qdrant.scroll(collection, {
    filter,
    limit,
    with_payload: true,
    with_vector: false,
  })) as { points?: QdrantPoint[] };
  return res.points ?? [];
}

function symbolName(symbol: string): string {
  const trimmed = symbol.trim();
  const parts = trimmed.split(/[.:#]/).filter(Boolean);
  return parts.at(-1) ?? trimmed;
}

/* ── public API ─────────────────────────────────────────────────────── */

export interface FindOpts {
  embed: EmbedFn;
  query: string;
  k?: number;
  lang?: string | null;
  role?: string | null;
  layer?: string | null;
  mode?: 'semantic' | 'keyword' | 'hybrid';
}

export async function wrFind(opts: FindOpts): Promise<SearchResult[]> {
  const k = opts.k ?? 10;
  const mode = opts.mode ?? 'hybrid';
  const filter = buildFilter({
    language: opts.lang,
    role: opts.role,
    atomic_layer: opts.layer,
  });

  let rows: SearchResult[];
  if (mode === 'semantic') {
    rows = await searchSemantic({
      embed: opts.embed,
      queryText: opts.query,
      top_k: k,
      filter,
    });
  } else if (mode === 'keyword') {
    rows = await searchKeyword({ queryText: opts.query, top_k: k, filter });
  } else {
    rows = await searchHybrid({
      embed: opts.embed,
      queryText: opts.query,
      top_k: k,
      filter,
    });
  }
  return rows;
}

export interface FileChunk {
  id: string | number;
  chunk_index: number;
  start_line: number;
  end_line: number;
  symbol_kind: string | null;
  symbol_name: string | null;
  language: string;
  role: string | null;
  content: string;
}

export async function wrFile(opts: { path: string }): Promise<FileChunk[]> {
  const res = (await qdrant.scroll(COLLECTION, {
    filter: { must: [{ key: 'file_path', match: { value: opts.path } }] },
    limit: 1000,
    with_payload: true,
    with_vector: false,
  })) as { points?: QdrantPoint[] };
  return (res.points ?? [])
    .map((pt) => {
      const p = (pt.payload ?? {}) as Record<string, unknown>;
      return {
        id: pt.id,
        chunk_index: (p.chunk_index as number) ?? 0,
        start_line: (p.start_line as number) ?? 0,
        end_line: (p.end_line as number) ?? 0,
        symbol_kind: (p.symbol_kind as string | null) ?? null,
        symbol_name: (p.symbol_name as string | null) ?? null,
        language: (p.language as string) ?? 'text',
        role: (p.role as string | null) ?? null,
        content: (p.content as string) ?? '',
      };
    })
    .sort((a, b) => a.chunk_index - b.chunk_index);
}

export interface SymbolSearchResult {
  id: string | number;
  node_id?: string;
  kind?: string;
  name?: string;
  fqn?: string;
  file_path?: string;
  start_line?: number;
  end_line?: number;
  language?: string;
  signature?: string;
  graph_text?: string;
  calls: string[];
  imports: string[];
  imported_files: string[];
  exports: string[];
  type_refs: string[];
  base_types: string[];
  implements: string[];
  score: number | null;
}

function payloadToSymbolResult(point: QdrantPoint): SymbolSearchResult {
  const p = (point.payload ?? {}) as Record<string, unknown>;
  return {
    id: point.id,
    node_id: p.node_id as string | undefined,
    kind: p.kind as string | undefined,
    name: p.name as string | undefined,
    fqn: p.fqn as string | undefined,
    file_path: p.file_path as string | undefined,
    start_line: p.start_line as number | undefined,
    end_line: p.end_line as number | undefined,
    language: p.language as string | undefined,
    signature: p.signature as string | undefined,
    graph_text: p.graph_text as string | undefined,
    calls: asStringArray(p.calls),
    imports: asStringArray(p.imports),
    imported_files: asStringArray(p.imported_files),
    exports: asStringArray(p.exports),
    type_refs: asStringArray(p.type_refs),
    base_types: asStringArray(p.base_types),
    implements: asStringArray(p.implements),
    score: point.score ?? null,
  };
}

export async function wrSymbolFind(opts: {
  embed: EmbedFn;
  query: string;
  k?: number;
  kind?: string | null;
  lang?: string | null;
}): Promise<SymbolSearchResult[]> {
  const k = opts.k ?? 10;
  const vec = await opts.embed(opts.query);
  const must: Record<string, unknown>[] = [];
  if (opts.kind) must.push({ key: 'kind', match: { value: opts.kind } });
  if (opts.lang) must.push({ key: 'language', match: { value: opts.lang } });
  const semanticFilter = must.length ? { must } : undefined;
  const keywordFilter = { must: [{ key: 'graph_text', match: { text: opts.query } }, ...must] };
  const res = (await qdrant.query(SYMBOL_COLLECTION, {
    prefetch: [
      { query: vec, limit: k * 4, filter: semanticFilter },
      { filter: keywordFilter, limit: k * 4 },
    ],
    query: { fusion: 'rrf' },
    limit: k,
    with_payload: true,
  })) as { points?: QdrantPoint[] };
  return (res.points ?? []).map(payloadToSymbolResult);
}

export async function wrCallers(opts: { symbol: string; k?: number }): Promise<SearchResult[]> {
  if (PROJECT_CONFIG.graphProvider === 'neo4j') {
    const err = neo4jConfigError(PROJECT_CONFIG);
    if (err) throw new Error(err);
    return await neo4jCallers(PROJECT_CONFIG, opts.symbol, opts.k ?? 20) as SearchResult[];
  }
  const name = symbolName(opts.symbol);
  const points = await scrollCollection(COLLECTION, anyValueFilter(['calls', 'references'], name), opts.k ?? 20);
  return points.map((pt) => ({ ...payloadToResult(pt), score: 1.0 }));
}

export async function wrCallees(opts: { symbolOrFile: string; k?: number }): Promise<{ calls: string[]; chunks: SearchResult[] }> {
  if (PROJECT_CONFIG.graphProvider === 'neo4j') {
    const err = neo4jConfigError(PROJECT_CONFIG);
    if (err) throw new Error(err);
    return await neo4jCallees(PROJECT_CONFIG, opts.symbolOrFile, opts.k ?? 20) as { calls: string[]; chunks: SearchResult[] };
  }
  const target = opts.symbolOrFile.trim();
  const name = symbolName(target);
  const filter = target.startsWith('/')
    ? valueFilter('file_path', target)
    : {
        should: [
          { key: 'declared_symbols', match: { value: name } },
          { key: 'symbol_name', match: { value: target } },
          { key: 'symbol_fqn', match: { value: target } },
        ],
      };
  const chunks = (await scrollCollection(COLLECTION, filter, opts.k ?? 20)).map((pt) => ({
    ...payloadToResult(pt),
    score: 1.0,
  }));
  const calls = [...new Set(chunks.flatMap((chunk) => chunk.calls))];
  return { calls, chunks };
}

export async function wrImporters(opts: { pathOrModule: string; k?: number }): Promise<SearchResult[]> {
  if (PROJECT_CONFIG.graphProvider === 'neo4j') {
    const err = neo4jConfigError(PROJECT_CONFIG);
    if (err) throw new Error(err);
    return await neo4jImporters(PROJECT_CONFIG, opts.pathOrModule, opts.k ?? 20) as SearchResult[];
  }
  const points = await scrollCollection(
    COLLECTION,
    anyValueFilter(['imports', 'imported_files'], opts.pathOrModule),
    opts.k ?? 20,
  );
  return points.map((pt) => ({ ...payloadToResult(pt), score: 1.0 }));
}

export async function wrExports(opts: { path: string; k?: number }): Promise<{ exports: string[]; chunks: SearchResult[] }> {
  if (PROJECT_CONFIG.graphProvider === 'neo4j') {
    const err = neo4jConfigError(PROJECT_CONFIG);
    if (err) throw new Error(err);
    return await neo4jExports(PROJECT_CONFIG, opts.path, opts.k ?? 100) as { exports: string[]; chunks: SearchResult[] };
  }
  const chunks = (await scrollCollection(COLLECTION, valueFilter('file_path', opts.path), opts.k ?? 100)).map((pt) => ({
    ...payloadToResult(pt),
    score: 1.0,
  }));
  const exports = [...new Set(chunks.flatMap((chunk) => chunk.exports))];
  return { exports, chunks };
}

export interface ArchImpactFile {
  path: string;
  score: number;
  reasons: string[];
  top_symbols: string[];
  edges: Array<{ kind: string; target: string; line?: number }>;
  source: string[];
}

function addArchImpact(
  byFile: Map<string, ArchImpactFile>,
  filePath: string | undefined,
  language: string | undefined,
  score: number,
  reason: string,
  source: string,
  symbols: string[],
  edges: Array<{ kind: string; target: string; line?: number }> = [],
): void {
  if (!filePath) return;
  const entry = byFile.get(filePath) ?? {
    path: filePath,
    score: 0,
    reasons: [],
    top_symbols: [],
    edges: [],
    source: [],
  };
  entry.score += score * impactWeight(language, filePath);
  if (!entry.reasons.includes(reason) && entry.reasons.length < 8) entry.reasons.push(reason);
  for (const symbol of symbols) {
    if (symbol && !entry.top_symbols.includes(symbol) && entry.top_symbols.length < 8) entry.top_symbols.push(symbol);
  }
  for (const edge of edges) {
    if (entry.edges.length < 16) entry.edges.push(edge);
  }
  if (!entry.source.includes(source)) entry.source.push(source);
  byFile.set(filePath, entry);
}

export async function wrArchImpact(opts: {
  embed: EmbedFn;
  description: string;
  k?: number;
}): Promise<ArchImpactFile[]> {
  const k = opts.k ?? 15;
  const semanticHits = await searchHybrid({ embed: opts.embed, queryText: opts.description, top_k: 80, filter: undefined });
  let symbolHits: SymbolSearchResult[] = [];
  try {
    symbolHits = await wrSymbolFind({ embed: opts.embed, query: opts.description, k: 40 });
  } catch {
    symbolHits = [];
  }

  const byFile = new Map<string, ArchImpactFile>();
  const seedFiles = new Set<string>();
  const seedSymbols = new Set<string>();

  for (const hit of semanticHits) {
    const score = hit.score ?? 0.5;
    addArchImpact(
      byFile,
      hit.file_path,
      hit.language,
      score,
      `semantic hit${hit.symbol_name ? `: ${hit.symbol_name}` : ''}`,
      'semantic',
      [hit.symbol_name ?? '', ...hit.declared_symbols],
    );
    if (hit.file_path) seedFiles.add(hit.file_path);
    for (const symbol of [hit.symbol_name ?? '', ...hit.declared_symbols]) {
      if (symbol) seedSymbols.add(symbolName(symbol));
    }
  }

  for (const hit of symbolHits) {
    addArchImpact(
      byFile,
      hit.file_path,
      hit.language,
      hit.score ?? 0.7,
      `symbol hit${hit.name ? `: ${hit.name}` : ''}`,
      'symbol',
      [hit.name ?? '', hit.fqn ?? ''],
    );
    if (hit.file_path) seedFiles.add(hit.file_path);
    if (hit.name) seedSymbols.add(symbolName(hit.name));
    if (hit.fqn) seedSymbols.add(symbolName(hit.fqn));
  }

  if (neo4jEnabled(PROJECT_CONFIG)) {
    for (const symbol of [...seedSymbols].slice(0, 20)) {
      const callers = await neo4jCallers(PROJECT_CONFIG, symbol, 20) as SearchResult[];
      for (const hit of callers) {
        addArchImpact(byFile, hit.file_path, hit.language, 0.65, `neo4j caller ${symbol}`, 'caller', [hit.symbol_name ?? '', ...hit.declared_symbols], [{ kind: 'calls', target: symbol, line: hit.start_line }]);
      }
    }
    for (const filePath of [...seedFiles].slice(0, 20)) {
      const importers = await neo4jImporters(PROJECT_CONFIG, filePath, 20) as SearchResult[];
      for (const hit of importers) {
        addArchImpact(byFile, hit.file_path, hit.language, 0.6, `neo4j imports ${filePath}`, 'importer', [hit.symbol_name ?? '', ...hit.declared_symbols], [{ kind: 'imports', target: filePath, line: hit.start_line }]);
      }
    }
    return [...byFile.values()].sort((a, b) => b.score - a.score).slice(0, k);
  }

  for (const symbol of [...seedSymbols].slice(0, 20)) {
    const [callers, typeUsers, exporters] = await Promise.all([
      scrollCollection(COLLECTION, anyValueFilter(['calls', 'references'], symbol), 20),
      scrollCollection(COLLECTION, anyValueFilter(['type_refs', 'base_types', 'implements'], symbol), 20),
      scrollCollection(COLLECTION, valueFilter('exports', symbol), 20),
    ]);
    for (const point of callers) {
      const hit = payloadToResult(point);
      addArchImpact(byFile, hit.file_path, hit.language, 0.55, `calls/references ${symbol}`, 'caller', [hit.symbol_name ?? '', ...hit.declared_symbols], [{ kind: 'calls', target: symbol, line: hit.start_line }]);
    }
    for (const point of typeUsers) {
      const hit = payloadToResult(point);
      addArchImpact(byFile, hit.file_path, hit.language, 0.45, `type relation ${symbol}`, 'type_relation', [hit.symbol_name ?? '', ...hit.declared_symbols], [{ kind: 'type_relation', target: symbol, line: hit.start_line }]);
    }
    for (const point of exporters) {
      const hit = payloadToResult(point);
      addArchImpact(byFile, hit.file_path, hit.language, 0.35, `exports ${symbol}`, 'symbol', [symbol, hit.symbol_name ?? ''], [{ kind: 'exports', target: symbol, line: hit.start_line }]);
    }
  }

  for (const filePath of [...seedFiles].slice(0, 20)) {
    const importers = await scrollCollection(COLLECTION, anyValueFilter(['imports', 'imported_files'], filePath), 20);
    for (const point of importers) {
      const hit = payloadToResult(point);
      addArchImpact(byFile, hit.file_path, hit.language, 0.5, `imports ${filePath}`, 'importer', [hit.symbol_name ?? '', ...hit.declared_symbols], [{ kind: 'imports', target: filePath, line: hit.start_line }]);
    }
  }

  return [...byFile.values()].sort((a, b) => b.score - a.score).slice(0, k);
}

export interface ImpactFile {
  file_path: string;
  language: string;
  role: string | null;
  total_score: number;
  chunk_count_in_results: number;
  top_symbols: string[];
}

export async function wrImpact(opts: {
  embed: EmbedFn;
  description: string;
  k?: number;
}): Promise<ImpactFile[]> {
  const k = opts.k ?? 15;
  const hits = await searchHybrid({
    embed: opts.embed,
    queryText: opts.description,
    top_k: 80,
    filter: undefined,
  });
  const byFile = new Map<string, ImpactFile & { _symbols: Set<string> }>();
  for (const h of hits) {
    if (!h.file_path) continue;
    const w = impactWeight(h.language, h.file_path);
    const entry = byFile.get(h.file_path) ?? {
      file_path: h.file_path,
      language: h.language ?? 'text',
      role: h.role ?? null,
      total_score: 0,
      chunk_count_in_results: 0,
      top_symbols: [] as string[],
      _symbols: new Set<string>(),
    };
    entry.total_score += (h.score ?? 0) * w;
    entry.chunk_count_in_results += 1;
    if (h.symbol_name && !entry._symbols.has(h.symbol_name) && entry.top_symbols.length < 3) {
      entry.top_symbols.push(h.symbol_name);
      entry._symbols.add(h.symbol_name);
    }
    byFile.set(h.file_path, entry);
  }
  return [...byFile.values()]
    .map(({ _symbols: _drop, ...rest }) => rest)
    .sort((a, b) => b.total_score - a.total_score)
    .slice(0, k);
}

export interface IndexStatus {
  collection: string;
  status: string;
  points_count: number;
  vectors_count?: number;
  indexed_vectors_count?: number;
  vector_size?: number;
  distance?: string;
}

export async function wrIndexStatus(): Promise<IndexStatus> {
  const info = (await qdrant.getCollection(COLLECTION)) as {
    status: string;
    points_count: number;
    vectors_count?: number;
    indexed_vectors_count?: number;
    config?: { params?: { vectors?: { size: number; distance: string } } };
  };
  return {
    collection: COLLECTION,
    status: info.status,
    points_count: info.points_count,
    vectors_count: info.vectors_count,
    indexed_vectors_count: info.indexed_vectors_count,
    vector_size: info.config?.params?.vectors?.size,
    distance: info.config?.params?.vectors?.distance,
  };
}
