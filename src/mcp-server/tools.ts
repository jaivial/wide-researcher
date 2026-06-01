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
type RerankFn = (query: string, docs: string[]) => Promise<number[]>;
const SYMBOL_COLLECTION = `${COLLECTION}_symbols`;

// Per-file cap applied after rerank for diversification. Prevents one
// chunk-dense file (e.g. a generated SDK) from monopolising the top-k.
const PER_FILE_CAP_DEFAULT = 3;

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
  runtime?: string | null;
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
  call_arg_literals: string[];
  storage_keys: string[];
  type_refs: string[];
  base_types: string[];
  implements: string[];
  references: string[];
  graph_text?: string;
  callsite_text?: string;
  preview: string;
  code_lines: Array<{ line: number; text: string }>;
  line_count: number;
  content_chars: number;
  score: number | null;
  retrieval_channels?: string[];
  matched_terms?: string[];
  match_reason?: string;
  intent?: string | null;
  warnings?: string[];
  possible_false_positive?: boolean;
  filter_relaxed?: boolean;
}

export interface CompactSearchResult extends Omit<SearchResult, 'code_lines'> {
  snippet_lines?: Array<{ line: number; text: string }>;
  omitted_lines?: number;
  has_more_content: boolean;
}

/* ── helpers ────────────────────────────────────────────────────────── */

interface FilterOpts {
  language?: string | null;
  role?: string | null;
  runtime?: string | null;
  atomic_layer?: string | null;
}

function buildFilter(opts: FilterOpts): { must: Record<string, unknown>[] } | undefined {
  const must: Record<string, unknown>[] = [];
  if (opts.language) must.push({ key: 'language', match: { value: opts.language } });
  if (opts.role) must.push({ key: 'role', match: { value: opts.role } });
  if (opts.runtime) must.push({ key: 'runtime', match: { value: opts.runtime } });
  if (opts.atomic_layer) {
    must.push({ key: 'atomic_layer', match: { value: opts.atomic_layer } });
  }
  return must.length ? { must } : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function payloadText(p: Record<string, unknown>, key: string): string | undefined {
  const value = p[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function payloadToResult(point: QdrantPoint): SearchResult {
  const p = (point.payload ?? {}) as Record<string, unknown>;
  const content = typeof p.content === 'string' ? p.content : '';
  const startLine = typeof p.start_line === 'number' ? p.start_line : 1;
  const lines = content.split(/\r?\n/);
  return {
    id: point.id,
    file_path: p.file_path as string | undefined,
    start_line: p.start_line as number | undefined,
    end_line: p.end_line as number | undefined,
    language: p.language as string | undefined,
    role: (p.role as string | null) ?? null,
    runtime: (p.runtime as string | null) ?? null,
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
    call_arg_literals: asStringArray(p.call_arg_literals),
    storage_keys: asStringArray(p.storage_keys),
    type_refs: asStringArray(p.type_refs),
    base_types: asStringArray(p.base_types),
    implements: asStringArray(p.implements),
    references: asStringArray(p.references),
    graph_text: payloadText(p, 'graph_text'),
    callsite_text: payloadText(p, 'callsite_text'),
    preview: content.slice(0, 500),
    code_lines: lines.map((text, idx) => ({
      line: startLine + idx,
      text,
    })),
    line_count: lines.length,
    content_chars: content.length,
    score: point.score ?? null,
  };
}

export function compactSearchResult(row: SearchResult, snippetLines = 20, includeCodeLines = false): SearchResult | CompactSearchResult {
  const hasMore = row.code_lines.length > snippetLines;
  if (includeCodeLines) {
    return {
      ...row,
      has_more_content: false,
    } as SearchResult & { has_more_content: boolean };
  }
  const { code_lines: codeLines, ...rest } = row;
  return {
    ...rest,
    snippet_lines: codeLines.slice(0, Math.max(0, snippetLines)),
    omitted_lines: Math.max(0, codeLines.length - snippetLines),
    has_more_content: hasMore,
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

/* ── window expansion ───────────────────────────────────────────────────
 * Fetches the ±1 neighbor chunks of each hit and stitches their content
 * into one wider passage. Reranker quality is materially better with
 * 200–600 line windows than with 50-line raw chunks, so this is done
 * unconditionally before rerank.
 */

async function expandWindows(rows: SearchResult[]): Promise<SearchResult[]> {
  if (rows.length === 0) return rows;
  const byFile = new Map<string, SearchResult[]>();
  for (const r of rows) {
    if (!r.file_path) continue;
    const arr = byFile.get(r.file_path) ?? [];
    arr.push(r);
    byFile.set(r.file_path, arr);
  }
  const idCache = new Map<string, string>();
  await Promise.all(
    [...byFile.entries()].map(async ([file_path, hits]) => {
      const chunks = (await qdrant.scroll(COLLECTION, {
        filter: { must: [{ key: 'file_path', match: { value: file_path } }] },
        limit: 500,
        with_payload: true,
        with_vector: false,
      })) as { points?: QdrantPoint[] };
      const ordered = (chunks.points ?? [])
        .map((pt) => ({ pt, idx: (pt.payload?.chunk_index as number) ?? 0 }))
        .sort((a, b) => a.idx - b.idx);
      const indexById = new Map<string, number>();
      ordered.forEach((entry, i) => indexById.set(String(entry.pt.id), i));
      for (const hit of hits) {
        const k = `${file_path}:${hit.id}`;
        const pos = indexById.get(String(hit.id));
        if (pos === undefined) continue;
        const start = Math.max(0, pos - 1);
        const end = Math.min(ordered.length - 1, pos + 1);
        const text = ordered
          .slice(start, end + 1)
          .map(({ pt }) => (pt.payload?.content as string) ?? '')
          .join('\n');
        if (text) idCache.set(k, text.slice(0, 4000));
      }
    }),
  );
  return rows.map((r) => {
    if (!r.file_path) return r;
    const text = idCache.get(`${r.file_path}:${r.id}`);
    return text ? { ...r, preview: text.slice(0, 500), _rerank_text: text } as SearchResult & { _rerank_text: string } : r;
  });
}

/* ── rerank stage ───────────────────────────────────────────────────────
 * Cohere rerank-v3.5 over the expanded windows. Replaces RRF reciprocal
 * score with the cross-encoder relevance score so the downstream
 * aggregator weights by post-rerank relevance.
 */

async function rerankRows(
  rerank: RerankFn | undefined,
  query: string,
  rows: SearchResult[],
  keep: number,
): Promise<SearchResult[]> {
  if (!rerank || rows.length === 0) return rows;
  const docs = rows.map((r) => {
    const widened = (r as SearchResult & { _rerank_text?: string })._rerank_text;
    const body = widened && widened.length > 0 ? widened : r.code_lines.map((l) => l.text).join('\n').slice(0, 4000);
    const meta = [
      r.file_path ? `path: ${r.file_path}` : '',
      r.language ? `language: ${r.language}` : '',
      r.role ? `role: ${r.role}` : '',
      r.runtime ? `runtime: ${r.runtime}` : '',
      r.atomic_layer ? `layer: ${r.atomic_layer}` : '',
      r.symbol_name ? `symbol: ${r.symbol_name}` : '',
      r.graph_text ? `graph: ${r.graph_text}` : '',
      r.callsite_text ? `callsites: ${r.callsite_text}` : '',
    ].filter(Boolean).join('\n');
    return `${meta}\n\n${body}`.slice(0, 5000);
  });
  let scores: number[];
  try {
    scores = await rerank(query, docs);
  } catch (e) {
    process.stderr.write(`[wide-researcher] rerank skipped: ${(e as Error).message}\n`);
    return rows.slice(0, keep);
  }
  if (scores.length !== rows.length) return rows.slice(0, keep);
  return rows
    .map((row, i) => ({ ...row, score: scores[i] ?? 0 }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, keep);
}

/* ── diversification ────────────────────────────────────────────────────
 * Per-file cap. Keeps ranking order. Cheap; no embedding-MMR needed
 * since rerank scores already capture per-chunk relevance.
 */

function diversifyByFile(rows: SearchResult[], cap: number): SearchResult[] {
  if (cap <= 0) return rows;
  const counts = new Map<string, number>();
  const out: SearchResult[] = [];
  for (const r of rows) {
    const key = r.file_path ?? `__no_file__${r.id}`;
    const c = counts.get(key) ?? 0;
    if (c >= cap) continue;
    counts.set(key, c + 1);
    out.push(r);
  }
  return out;
}

/* ── search modes ───────────────────────────────────────────────────── */

interface ModeOpts {
  embed: EmbedFn;
  rerank?: RerankFn;
  queryText: string;
  top_k: number;
  filter: ReturnType<typeof buildFilter>;
  diversify?: boolean;
  perFileCap?: number;
}

const FUSION_MULTIPLIER = 6;

function queryTokens(query: string): string[] {
  return [...new Set(query
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9_.$-]+/)
    .filter((t) => t.length >= 2))];
}

function classifyIntent(query: string): string | null {
  const q = query.toLowerCase();
  if (/\b(localstorage|sessionstorage|indexeddb|cookie|storage key|browser storage|atomwithstorage|getitem|setitem|removeitem)\b/.test(q)) {
    return 'browser_storage';
  }
  return null;
}

function annotateSearchRows(rows: SearchResult[], query: string): SearchResult[] {
  const intent = classifyIntent(query);
  const tokens = queryTokens(query);
  return rows.map((row) => {
    const haystack = [
      row.file_path,
      row.symbol_name,
      row.graph_text,
      row.callsite_text,
      ...row.calls,
      ...row.call_arg_literals,
      ...row.storage_keys,
      row.preview,
    ].filter(Boolean).join(' ').toLowerCase();
    const matched = tokens.filter((t) => haystack.includes(t));
    const warnings: string[] = [];
    let possibleFalsePositive = false;
    let score = row.score ?? 0;
    if (intent === 'browser_storage') {
      const browserish = row.runtime === 'browser' || row.role === 'frontend' || row.language === 'tsx' || row.storage_keys.length > 0;
      const backendish = row.runtime === 'dotnet' || row.runtime === 'node' || row.role === 'backend' || row.language === 'csharp';
      if (browserish) score += 0.2;
      if (backendish && row.storage_keys.length === 0) {
        score -= 0.25;
        possibleFalsePositive = true;
        warnings.push(`${row.language ?? row.runtime ?? 'result'} mismatches inferred browser-storage intent`);
      }
      if (!matched.some((t) => ['localstorage', 'sessionstorage', 'indexeddb', 'cookie', 'storage', 'atomwithstorage', 'getitem', 'setitem', 'removeitem'].includes(t))) {
        warnings.push('no direct browser-storage token matched');
      }
    }
    return {
      ...row,
      score,
      intent,
      matched_terms: matched,
      match_reason: matched.length ? `matched ${matched.slice(0, 5).join(', ')}` : 'semantic-only or graph-neighbor match',
      warnings,
      possible_false_positive: possibleFalsePositive,
    };
  }).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

async function searchSemantic(opts: ModeOpts): Promise<SearchResult[]> {
  const vec = await opts.embed(opts.queryText);
  const fetchK = opts.rerank ? Math.max(opts.top_k * FUSION_MULTIPLIER, 40) : opts.top_k;
  const res = (await qdrant.query(COLLECTION, {
    query: vec,
    limit: fetchK,
    filter: opts.filter,
    with_payload: true,
    params: { hnsw_ef: 128 },
  })) as { points?: QdrantPoint[] };
  const rows = (res.points ?? []).map(payloadToResult);
  return finalizeSearch(opts, rows);
}

async function searchKeyword(
  opts: Omit<ModeOpts, 'embed'> & { embed?: EmbedFn },
): Promise<SearchResult[]> {
  const must: Record<string, unknown>[] = [
    { key: 'content', match: { text: opts.queryText } },
    ...(opts.filter?.must ?? []),
  ];
  const fetchK = opts.rerank ? Math.max(opts.top_k * FUSION_MULTIPLIER, 40) : opts.top_k;
  const res = (await qdrant.scroll(COLLECTION, {
    filter: { must },
    limit: fetchK,
    with_payload: true,
    with_vector: false,
  })) as { points?: QdrantPoint[] };
  const rows = (res.points ?? []).map((pt) => ({
    ...payloadToResult(pt),
    score: 1.0,
    retrieval_channels: ['keyword'],
  }));
  return finalizeSearch(opts as ModeOpts, rows);
}

async function searchHybrid(opts: ModeOpts): Promise<SearchResult[]> {
  const vec = await opts.embed(opts.queryText);
  const keywordMust: Record<string, unknown>[] = [
    { key: 'content', match: { text: opts.queryText } },
    ...(opts.filter?.must ?? []),
  ];
  const fetchK = opts.rerank ? Math.max(opts.top_k * FUSION_MULTIPLIER, 40) : opts.top_k;
  const res = (await qdrant.query(COLLECTION, {
    prefetch: [
      { query: vec, using: '', limit: fetchK, filter: opts.filter },
      { filter: { must: keywordMust }, limit: fetchK },
    ],
    query: { fusion: 'rrf' },
    limit: fetchK,
    with_payload: true,
  })) as { points?: QdrantPoint[] };
  const rows = (res.points ?? []).map((pt) => ({
    ...payloadToResult(pt),
    retrieval_channels: ['hybrid'],
  }));
  return finalizeSearch(opts, rows);
}

/* Window-expand → rerank → diversify → top-k.
 *
 * Centralised so all three modes get the same post-retrieval pipeline.
 * Reranking is gated by the presence of `rerank` on the opts; absent it,
 * this collapses to "trim to top_k".
 */
async function finalizeSearch(opts: ModeOpts, rows: SearchResult[]): Promise<SearchResult[]> {
  let working = rows;
  if (opts.rerank) {
    working = await expandWindows(working);
    working = await rerankRows(opts.rerank, opts.queryText, working, opts.top_k * 2);
  }
  working = annotateSearchRows(working, opts.queryText);
  if (opts.diversify !== false) {
    working = diversifyByFile(working, opts.perFileCap ?? PER_FILE_CAP_DEFAULT);
  }
  return working.slice(0, opts.top_k);
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
  rerank?: RerankFn;
  query: string;
  k?: number;
  lang?: string | null;
  role?: string | null;
  runtime?: string | null;
  layer?: string | null;
  mode?: 'semantic' | 'keyword' | 'hybrid';
  diversify?: boolean;
  perFileCap?: number;
}

export async function wrFind(opts: FindOpts): Promise<SearchResult[]> {
  const k = opts.k ?? 10;
  const mode = opts.mode ?? 'hybrid';
  const filter = buildFilter({
    language: opts.lang,
    role: opts.role,
    runtime: opts.runtime,
    atomic_layer: opts.layer,
  });

  const baseOpts: ModeOpts = {
    embed: opts.embed,
    rerank: opts.rerank,
    queryText: opts.query,
    top_k: k,
    filter,
    diversify: opts.diversify,
    perFileCap: opts.perFileCap,
  };

  if (mode === 'semantic') return searchSemantic(baseOpts);
  if (mode === 'keyword') return searchKeyword(baseOpts);
  return searchHybrid(baseOpts);
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
  runtime: string | null;
  content?: string;
  preview?: string;
  content_chars: number;
  line_count: number;
}

export interface FileResult {
  chunks: FileChunk[];
  next_offset: number | null;
  returned: number;
  content_mode: 'none' | 'preview' | 'full';
}

export async function wrFile(opts: {
  path: string;
  offset?: number;
  limit?: number;
  contentMode?: 'none' | 'preview' | 'full';
  maxChars?: number;
}): Promise<FileResult> {
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.min(Math.max(1, opts.limit ?? 20), 100);
  const contentMode = opts.contentMode ?? 'preview';
  const maxChars = Math.max(200, opts.maxChars ?? 2000);
  const res = (await qdrant.scroll(COLLECTION, {
    filter: { must: [{ key: 'file_path', match: { value: opts.path } }] },
    limit: 1000,
    with_payload: true,
    with_vector: false,
  })) as { points?: QdrantPoint[] };
  const all = (res.points ?? [])
    .map((pt) => {
      const p = (pt.payload ?? {}) as Record<string, unknown>;
      const content = (p.content as string) ?? '';
      const base: FileChunk = {
        id: pt.id,
        chunk_index: (p.chunk_index as number) ?? 0,
        start_line: (p.start_line as number) ?? 0,
        end_line: (p.end_line as number) ?? 0,
        symbol_kind: (p.symbol_kind as string | null) ?? null,
        symbol_name: (p.symbol_name as string | null) ?? null,
        language: (p.language as string) ?? 'text',
        role: (p.role as string | null) ?? null,
        runtime: (p.runtime as string | null) ?? null,
        content_chars: content.length,
        line_count: content ? content.split(/\r?\n/).length : 0,
      };
      if (contentMode === 'full') base.content = content.slice(0, maxChars);
      if (contentMode === 'preview') base.preview = content.slice(0, Math.min(maxChars, 1000));
      return base;
    })
    .sort((a, b) => a.chunk_index - b.chunk_index);
  const chunks = all.slice(offset, offset + limit);
  const nextOffset = offset + chunks.length < all.length ? offset + chunks.length : null;
  return { chunks, next_offset: nextOffset, returned: chunks.length, content_mode: contentMode };
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
  rerank?: RerankFn;
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
  const fetchK = opts.rerank ? Math.max(k * FUSION_MULTIPLIER, 40) : k;
  const res = (await qdrant.query(SYMBOL_COLLECTION, {
    prefetch: [
      { query: vec, limit: fetchK, filter: semanticFilter },
      { filter: keywordFilter, limit: fetchK },
    ],
    query: { fusion: 'rrf' },
    limit: fetchK,
    with_payload: true,
  })) as { points?: QdrantPoint[] };
  const rows = (res.points ?? []).map(payloadToSymbolResult);
  if (!opts.rerank || rows.length === 0) return rows.slice(0, k);
  const docs = rows.map((r) => (r.graph_text ?? r.signature ?? r.fqn ?? r.name ?? '').slice(0, 4000));
  let scores: number[];
  try {
    scores = await opts.rerank(opts.query, docs);
  } catch (e) {
    process.stderr.write(`[wide-researcher] symbol rerank skipped: ${(e as Error).message}\n`);
    return rows.slice(0, k);
  }
  if (scores.length !== rows.length) return rows.slice(0, k);
  return rows
    .map((row, i) => ({ ...row, score: scores[i] ?? 0 }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, k);
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

export interface CallArgResult {
  file_path?: string;
  line?: number;
  callee?: string;
  compact_callee?: string;
  arg_index?: number;
  literal?: string;
  literal_type?: string;
  symbol_name?: string | null;
  code_span?: string;
}

export async function wrCallArgs(opts: {
  callee?: string | null;
  argIndex?: number | null;
  literal?: string | null;
  lang?: string | null;
  path?: string | null;
  k?: number;
}): Promise<CallArgResult[]> {
  const must: Record<string, unknown>[] = [];
  if (opts.path) must.push({ key: 'file_path', match: { value: opts.path } });
  if (opts.lang) must.push({ key: 'language', match: { value: opts.lang } });
  if (opts.literal) must.push({ key: 'call_arg_literals', match: { value: opts.literal } });
  if (opts.callee) must.push({ key: 'calls', match: { value: symbolName(opts.callee) } });
  const points = await scrollCollection(COLLECTION, must.length ? { must } : { must: [{ key: 'callsite_text', match: { text: opts.callee ?? opts.literal ?? '' } }] }, Math.min(opts.k ?? 50, 200));
  const out: CallArgResult[] = [];
  for (const pt of points) {
    const p = (pt.payload ?? {}) as Record<string, unknown>;
    const sites = Array.isArray(p.call_sites) ? p.call_sites as Record<string, unknown>[] : [];
    for (const site of sites) {
      const compact = typeof site.compact_callee === 'string' ? site.compact_callee : undefined;
      if (opts.callee && compact !== symbolName(opts.callee)) continue;
      const maps = Array.isArray(site.arg_literal_map) ? site.arg_literal_map as Record<string, unknown>[] : [];
      for (const m of maps) {
        const argIndex = typeof m.arg_index === 'number' ? m.arg_index : undefined;
        const literal = typeof m.literal === 'string' ? m.literal : undefined;
        if (opts.argIndex !== undefined && opts.argIndex !== null && argIndex !== opts.argIndex) continue;
        if (opts.literal && literal !== opts.literal) continue;
        out.push({
          file_path: p.file_path as string | undefined,
          line: typeof site.line === 'number' ? site.line : undefined,
          callee: site.callee as string | undefined,
          compact_callee: compact,
          arg_index: argIndex,
          literal,
          literal_type: m.literal_type as string | undefined,
          symbol_name: (p.symbol_name as string | null) ?? null,
          code_span: site.code_span as string | undefined,
        });
      }
    }
  }
  const seen = new Set<string>();
  return out.filter((row) => {
    const key = `${row.file_path}:${row.line}:${row.compact_callee}:${row.arg_index}:${row.literal}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, opts.k ?? 50);
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
  rerank?: RerankFn;
  description: string;
  k?: number;
}): Promise<ArchImpactFile[]> {
  const k = opts.k ?? 15;
  const semanticHits = await searchHybrid({
    embed: opts.embed,
    rerank: opts.rerank,
    queryText: opts.description,
    top_k: 80,
    filter: undefined,
    diversify: false,
  });
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
  rerank?: RerankFn;
  description: string;
  k?: number;
}): Promise<ImpactFile[]> {
  const k = opts.k ?? 15;
  const hits = await searchHybrid({
    embed: opts.embed,
    rerank: opts.rerank,
    queryText: opts.description,
    top_k: 80,
    filter: undefined,
    diversify: false,
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
