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
import { neo4jCallers, neo4jCallees, neo4jConfigError, neo4jEnabled, neo4jExports, neo4jImporters, } from './neo4j.js';
const SYMBOL_COLLECTION = `${COLLECTION}_symbols`;
// Per-file cap applied after rerank for diversification. Prevents one
// chunk-dense file (e.g. a generated SDK) from monopolising the top-k.
const PER_FILE_CAP_DEFAULT = 3;
function buildFilter(opts) {
    const must = [];
    if (opts.language)
        must.push({ key: 'language', match: { value: opts.language } });
    if (opts.role)
        must.push({ key: 'role', match: { value: opts.role } });
    if (opts.atomic_layer) {
        must.push({ key: 'atomic_layer', match: { value: opts.atomic_layer } });
    }
    return must.length ? { must } : undefined;
}
function asStringArray(value) {
    return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
}
function payloadToResult(point) {
    const p = (point.payload ?? {});
    const content = typeof p.content === 'string' ? p.content : '';
    const startLine = typeof p.start_line === 'number' ? p.start_line : 1;
    return {
        id: point.id,
        file_path: p.file_path,
        start_line: p.start_line,
        end_line: p.end_line,
        language: p.language,
        role: p.role ?? null,
        atomic_layer: p.atomic_layer ?? null,
        symbol_kind: p.symbol_kind ?? null,
        symbol_name: p.symbol_name ?? null,
        symbol_id: p.symbol_id ?? null,
        symbol_fqn: p.symbol_fqn ?? null,
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
const IMPACT_WEIGHT = {
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
function impactWeight(language, filePath) {
    if (filePath && filePath.endsWith('.stories.tsx'))
        return 0.3;
    if (filePath && /\.(spec|test)\.(ts|tsx)$/.test(filePath))
        return 0.5;
    if (filePath && /(_test\.go|_test\.py|_spec\.rb)$/.test(filePath))
        return 0.5;
    if (filePath && filePath.includes('/locales/'))
        return 0.2;
    return IMPACT_WEIGHT[language ?? ''] ?? 1.0;
}
/* ── window expansion ───────────────────────────────────────────────────
 * Fetches the ±1 neighbor chunks of each hit and stitches their content
 * into one wider passage. Reranker quality is materially better with
 * 200–600 line windows than with 50-line raw chunks, so this is done
 * unconditionally before rerank.
 */
async function expandWindows(rows) {
    if (rows.length === 0)
        return rows;
    const byFile = new Map();
    for (const r of rows) {
        if (!r.file_path)
            continue;
        const arr = byFile.get(r.file_path) ?? [];
        arr.push(r);
        byFile.set(r.file_path, arr);
    }
    const idCache = new Map();
    await Promise.all([...byFile.entries()].map(async ([file_path, hits]) => {
        const chunks = (await qdrant.scroll(COLLECTION, {
            filter: { must: [{ key: 'file_path', match: { value: file_path } }] },
            limit: 500,
            with_payload: true,
            with_vector: false,
        }));
        const ordered = (chunks.points ?? [])
            .map((pt) => ({ pt, idx: pt.payload?.chunk_index ?? 0 }))
            .sort((a, b) => a.idx - b.idx);
        const indexById = new Map();
        ordered.forEach((entry, i) => indexById.set(String(entry.pt.id), i));
        for (const hit of hits) {
            const k = `${file_path}:${hit.id}`;
            const pos = indexById.get(String(hit.id));
            if (pos === undefined)
                continue;
            const start = Math.max(0, pos - 1);
            const end = Math.min(ordered.length - 1, pos + 1);
            const text = ordered
                .slice(start, end + 1)
                .map(({ pt }) => pt.payload?.content ?? '')
                .join('\n');
            if (text)
                idCache.set(k, text.slice(0, 4000));
        }
    }));
    return rows.map((r) => {
        if (!r.file_path)
            return r;
        const text = idCache.get(`${r.file_path}:${r.id}`);
        return text ? { ...r, preview: text.slice(0, 500), _rerank_text: text } : r;
    });
}
/* ── rerank stage ───────────────────────────────────────────────────────
 * Cohere rerank-v3.5 over the expanded windows. Replaces RRF reciprocal
 * score with the cross-encoder relevance score so the downstream
 * aggregator weights by post-rerank relevance.
 */
async function rerankRows(rerank, query, rows, keep) {
    if (!rerank || rows.length === 0)
        return rows;
    const docs = rows.map((r) => {
        const widened = r._rerank_text;
        if (widened && widened.length > 0)
            return widened;
        return r.code_lines.map((l) => l.text).join('\n').slice(0, 4000);
    });
    let scores;
    try {
        scores = await rerank(query, docs);
    }
    catch (e) {
        process.stderr.write(`[wide-researcher] rerank skipped: ${e.message}\n`);
        return rows.slice(0, keep);
    }
    if (scores.length !== rows.length)
        return rows.slice(0, keep);
    return rows
        .map((row, i) => ({ ...row, score: scores[i] ?? 0 }))
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, keep);
}
/* ── diversification ────────────────────────────────────────────────────
 * Per-file cap. Keeps ranking order. Cheap; no embedding-MMR needed
 * since rerank scores already capture per-chunk relevance.
 */
function diversifyByFile(rows, cap) {
    if (cap <= 0)
        return rows;
    const counts = new Map();
    const out = [];
    for (const r of rows) {
        const key = r.file_path ?? `__no_file__${r.id}`;
        const c = counts.get(key) ?? 0;
        if (c >= cap)
            continue;
        counts.set(key, c + 1);
        out.push(r);
    }
    return out;
}
const FUSION_MULTIPLIER = 6;
async function searchSemantic(opts) {
    const vec = await opts.embed(opts.queryText);
    const fetchK = opts.rerank ? Math.max(opts.top_k * FUSION_MULTIPLIER, 40) : opts.top_k;
    const res = (await qdrant.query(COLLECTION, {
        query: vec,
        limit: fetchK,
        filter: opts.filter,
        with_payload: true,
        params: { hnsw_ef: 128 },
    }));
    const rows = (res.points ?? []).map(payloadToResult);
    return finalizeSearch(opts, rows);
}
async function searchKeyword(opts) {
    const must = [
        { key: 'content', match: { text: opts.queryText } },
    ];
    const fetchK = opts.rerank ? Math.max(opts.top_k * FUSION_MULTIPLIER, 40) : opts.top_k;
    // keyword mode ignores role/atomic_layer — they were indexed inconsistently
    // (null in Qdrant, correct values in metadata) and filtering causes false negatives
    const res = (await qdrant.scroll(COLLECTION, {
        filter: { must },
        limit: fetchK,
        with_payload: true,
        with_vector: false,
    }));
    const rows = (res.points ?? []).map((pt) => ({
        ...payloadToResult(pt),
        score: 1.0,
    }));
    return finalizeSearch(opts, rows);
}
async function searchHybrid(opts) {
    const vec = await opts.embed(opts.queryText);
    const keywordMust = [
        { key: 'content', match: { text: opts.queryText } },
    ];
    // Filter semantic prefetch to language only — role/atomic_layer are null in DB
    // due to incomplete re-indexing, so filtering on them causes false negatives.
    const semanticFilter = opts.filter
        ? { must: opts.filter.must.filter(f => f.key === 'language') }
        : undefined;
    const fetchK = opts.rerank ? Math.max(opts.top_k * FUSION_MULTIPLIER, 40) : opts.top_k;
    const res = (await qdrant.query(COLLECTION, {
        prefetch: [
            { query: vec, using: '', limit: fetchK, filter: semanticFilter },
            { filter: { must: keywordMust }, limit: fetchK },
        ],
        query: { fusion: 'rrf' },
        limit: fetchK,
        with_payload: true,
    }));
    const rows = (res.points ?? []).map(payloadToResult);
    return finalizeSearch(opts, rows);
}
/* Window-expand → rerank → diversify → top-k.
 *
 * Centralised so all three modes get the same post-retrieval pipeline.
 * Reranking is gated by the presence of `rerank` on the opts; absent it,
 * this collapses to "trim to top_k".
 */
async function finalizeSearch(opts, rows) {
    let working = rows;
    if (opts.rerank) {
        working = await expandWindows(working);
        working = await rerankRows(opts.rerank, opts.queryText, working, opts.top_k * 2);
    }
    if (opts.diversify !== false) {
        working = diversifyByFile(working, opts.perFileCap ?? PER_FILE_CAP_DEFAULT);
    }
    return working.slice(0, opts.top_k);
}
/* ── graph helpers ──────────────────────────────────────────────────── */
function valueFilter(field, value) {
    return { must: [{ key: field, match: { value } }] };
}
function anyValueFilter(fields, value) {
    return { should: fields.map((field) => ({ key: field, match: { value } })) };
}
async function scrollCollection(collection, filter, limit) {
    const res = (await qdrant.scroll(collection, {
        filter,
        limit,
        with_payload: true,
        with_vector: false,
    }));
    return res.points ?? [];
}
function symbolName(symbol) {
    const trimmed = symbol.trim();
    const parts = trimmed.split(/[.:#]/).filter(Boolean);
    return parts.at(-1) ?? trimmed;
}
export async function wrFind(opts) {
    const k = opts.k ?? 10;
    const mode = opts.mode ?? 'hybrid';
    const filter = buildFilter({
        language: opts.lang,
        role: opts.role,
        atomic_layer: opts.layer,
    });
    const baseOpts = {
        embed: opts.embed,
        rerank: opts.rerank,
        queryText: opts.query,
        top_k: k,
        filter,
        diversify: opts.diversify,
        perFileCap: opts.perFileCap,
    };
    if (mode === 'semantic')
        return searchSemantic(baseOpts);
    if (mode === 'keyword')
        return searchKeyword(baseOpts);
    return searchHybrid(baseOpts);
}
export async function wrFile(opts) {
    const res = (await qdrant.scroll(COLLECTION, {
        filter: { must: [{ key: 'file_path', match: { value: opts.path } }] },
        limit: 1000,
        with_payload: true,
        with_vector: false,
    }));
    return (res.points ?? [])
        .map((pt) => {
        const p = (pt.payload ?? {});
        return {
            id: pt.id,
            chunk_index: p.chunk_index ?? 0,
            start_line: p.start_line ?? 0,
            end_line: p.end_line ?? 0,
            symbol_kind: p.symbol_kind ?? null,
            symbol_name: p.symbol_name ?? null,
            language: p.language ?? 'text',
            role: p.role ?? null,
            content: p.content ?? '',
        };
    })
        .sort((a, b) => a.chunk_index - b.chunk_index);
}
function payloadToSymbolResult(point) {
    const p = (point.payload ?? {});
    return {
        id: point.id,
        node_id: p.node_id,
        kind: p.kind,
        name: p.name,
        fqn: p.fqn,
        file_path: p.file_path,
        start_line: p.start_line,
        end_line: p.end_line,
        language: p.language,
        signature: p.signature,
        graph_text: p.graph_text,
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
export async function wrSymbolFind(opts) {
    const k = opts.k ?? 10;
    const vec = await opts.embed(opts.query);
    const must = [];
    if (opts.kind)
        must.push({ key: 'kind', match: { value: opts.kind } });
    if (opts.lang)
        must.push({ key: 'language', match: { value: opts.lang } });
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
    }));
    const rows = (res.points ?? []).map(payloadToSymbolResult);
    if (!opts.rerank || rows.length === 0)
        return rows.slice(0, k);
    const docs = rows.map((r) => (r.graph_text ?? r.signature ?? r.fqn ?? r.name ?? '').slice(0, 4000));
    let scores;
    try {
        scores = await opts.rerank(opts.query, docs);
    }
    catch (e) {
        process.stderr.write(`[wide-researcher] symbol rerank skipped: ${e.message}\n`);
        return rows.slice(0, k);
    }
    if (scores.length !== rows.length)
        return rows.slice(0, k);
    return rows
        .map((row, i) => ({ ...row, score: scores[i] ?? 0 }))
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, k);
}
export async function wrCallers(opts) {
    if (PROJECT_CONFIG.graphProvider === 'neo4j') {
        const err = neo4jConfigError(PROJECT_CONFIG);
        if (err)
            throw new Error(err);
        return await neo4jCallers(PROJECT_CONFIG, opts.symbol, opts.k ?? 20);
    }
    const name = symbolName(opts.symbol);
    const points = await scrollCollection(COLLECTION, anyValueFilter(['calls', 'references'], name), opts.k ?? 20);
    return points.map((pt) => ({ ...payloadToResult(pt), score: 1.0 }));
}
export async function wrCallees(opts) {
    if (PROJECT_CONFIG.graphProvider === 'neo4j') {
        const err = neo4jConfigError(PROJECT_CONFIG);
        if (err)
            throw new Error(err);
        return await neo4jCallees(PROJECT_CONFIG, opts.symbolOrFile, opts.k ?? 20);
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
export async function wrImporters(opts) {
    if (PROJECT_CONFIG.graphProvider === 'neo4j') {
        const err = neo4jConfigError(PROJECT_CONFIG);
        if (err)
            throw new Error(err);
        return await neo4jImporters(PROJECT_CONFIG, opts.pathOrModule, opts.k ?? 20);
    }
    const points = await scrollCollection(COLLECTION, anyValueFilter(['imports', 'imported_files'], opts.pathOrModule), opts.k ?? 20);
    return points.map((pt) => ({ ...payloadToResult(pt), score: 1.0 }));
}
export async function wrExports(opts) {
    if (PROJECT_CONFIG.graphProvider === 'neo4j') {
        const err = neo4jConfigError(PROJECT_CONFIG);
        if (err)
            throw new Error(err);
        return await neo4jExports(PROJECT_CONFIG, opts.path, opts.k ?? 100);
    }
    const chunks = (await scrollCollection(COLLECTION, valueFilter('file_path', opts.path), opts.k ?? 100)).map((pt) => ({
        ...payloadToResult(pt),
        score: 1.0,
    }));
    const exports = [...new Set(chunks.flatMap((chunk) => chunk.exports))];
    return { exports, chunks };
}
function addArchImpact(byFile, filePath, language, score, reason, source, symbols, edges = []) {
    if (!filePath)
        return;
    const entry = byFile.get(filePath) ?? {
        path: filePath,
        score: 0,
        reasons: [],
        top_symbols: [],
        edges: [],
        source: [],
    };
    entry.score += score * impactWeight(language, filePath);
    if (!entry.reasons.includes(reason) && entry.reasons.length < 8)
        entry.reasons.push(reason);
    for (const symbol of symbols) {
        if (symbol && !entry.top_symbols.includes(symbol) && entry.top_symbols.length < 8)
            entry.top_symbols.push(symbol);
    }
    for (const edge of edges) {
        if (entry.edges.length < 16)
            entry.edges.push(edge);
    }
    if (!entry.source.includes(source))
        entry.source.push(source);
    byFile.set(filePath, entry);
}
export async function wrArchImpact(opts) {
    const k = opts.k ?? 15;
    const semanticHits = await searchHybrid({
        embed: opts.embed,
        rerank: opts.rerank,
        queryText: opts.description,
        top_k: 80,
        filter: undefined,
        diversify: false,
    });
    let symbolHits = [];
    try {
        symbolHits = await wrSymbolFind({ embed: opts.embed, query: opts.description, k: 40 });
    }
    catch {
        symbolHits = [];
    }
    const byFile = new Map();
    const seedFiles = new Set();
    const seedSymbols = new Set();
    for (const hit of semanticHits) {
        const score = hit.score ?? 0.5;
        addArchImpact(byFile, hit.file_path, hit.language, score, `semantic hit${hit.symbol_name ? `: ${hit.symbol_name}` : ''}`, 'semantic', [hit.symbol_name ?? '', ...hit.declared_symbols]);
        if (hit.file_path)
            seedFiles.add(hit.file_path);
        for (const symbol of [hit.symbol_name ?? '', ...hit.declared_symbols]) {
            if (symbol)
                seedSymbols.add(symbolName(symbol));
        }
    }
    for (const hit of symbolHits) {
        addArchImpact(byFile, hit.file_path, hit.language, hit.score ?? 0.7, `symbol hit${hit.name ? `: ${hit.name}` : ''}`, 'symbol', [hit.name ?? '', hit.fqn ?? '']);
        if (hit.file_path)
            seedFiles.add(hit.file_path);
        if (hit.name)
            seedSymbols.add(symbolName(hit.name));
        if (hit.fqn)
            seedSymbols.add(symbolName(hit.fqn));
    }
    if (neo4jEnabled(PROJECT_CONFIG)) {
        for (const symbol of [...seedSymbols].slice(0, 20)) {
            const callers = await neo4jCallers(PROJECT_CONFIG, symbol, 20);
            for (const hit of callers) {
                addArchImpact(byFile, hit.file_path, hit.language, 0.65, `neo4j caller ${symbol}`, 'caller', [hit.symbol_name ?? '', ...hit.declared_symbols], [{ kind: 'calls', target: symbol, line: hit.start_line }]);
            }
        }
        for (const filePath of [...seedFiles].slice(0, 20)) {
            const importers = await neo4jImporters(PROJECT_CONFIG, filePath, 20);
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
export async function wrImpact(opts) {
    const k = opts.k ?? 15;
    const hits = await searchHybrid({
        embed: opts.embed,
        rerank: opts.rerank,
        queryText: opts.description,
        top_k: 80,
        filter: undefined,
        diversify: false,
    });
    const byFile = new Map();
    for (const h of hits) {
        if (!h.file_path)
            continue;
        const w = impactWeight(h.language, h.file_path);
        const entry = byFile.get(h.file_path) ?? {
            file_path: h.file_path,
            language: h.language ?? 'text',
            role: h.role ?? null,
            total_score: 0,
            chunk_count_in_results: 0,
            top_symbols: [],
            _symbols: new Set(),
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
export async function wrIndexStatus() {
    const info = (await qdrant.getCollection(COLLECTION));
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
//# sourceMappingURL=tools.js.map