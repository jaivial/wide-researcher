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

import { qdrant, COLLECTION } from './db.js';

type EmbedFn = (text: string) => Promise<number[]>;

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
  if (opts.filter?.must) must.push(...opts.filter.must);
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
  if (opts.filter?.must) keywordMust.push(...opts.filter.must);
  const res = (await qdrant.query(COLLECTION, {
    prefetch: [
      { query: vec, using: '', limit: opts.top_k * 4, filter: opts.filter },
      { filter: { must: keywordMust }, limit: opts.top_k * 4 },
    ],
    query: { fusion: 'rrf' },
    limit: opts.top_k,
    with_payload: true,
  })) as { points?: QdrantPoint[] };
  return (res.points ?? []).map(payloadToResult);
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
