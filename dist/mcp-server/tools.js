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
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { qdrant, COLLECTION, SKILLS_COLLECTION, PROJECT_CONFIG } from './db.js';
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
    if (opts.runtime)
        must.push({ key: 'runtime', match: { value: opts.runtime } });
    if (opts.atomic_layer) {
        must.push({ key: 'atomic_layer', match: { value: opts.atomic_layer } });
    }
    return must.length ? { must } : undefined;
}
function asStringArray(value) {
    return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
}
function payloadText(p, key) {
    const value = p[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function keywordPrefetches(query, limit, filter) {
    const must = filter?.must ?? [];
    const exactFields = ['symbol_name', 'file_path', 'declared_symbols', 'exports', 'calls', 'call_arg_literals', 'storage_keys', 'references'];
    const textFields = ['content', 'graph_text', 'callsite_text'];
    return [
        ...exactFields.map((key) => ({
            filter: { must: [{ key, match: { value: query } }, ...must] },
            limit,
        })),
        ...textFields.map((key) => ({
            filter: { must: [{ key, match: { text: query } }, ...must] },
            limit,
        })),
    ];
}
function payloadToResult(point) {
    const p = (point.payload ?? {});
    const content = typeof p.content === 'string' ? p.content : '';
    const startLine = typeof p.start_line === 'number' ? p.start_line : 1;
    const lines = content.split(/\r?\n/);
    return {
        id: point.id,
        file_path: p.file_path,
        start_line: p.start_line,
        end_line: p.end_line,
        language: p.language,
        role: p.role ?? null,
        runtime: p.runtime ?? null,
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
const COMPACT_FIELD_CHAR_CAPS = {
    graph_text: 240,
    callsite_text: 240,
    preview: 300,
};
const COMPACT_ARRAY_CAPS = {
    declared_symbols: 25,
    imports: 15,
    imported_files: 10,
    exports: 25,
    calls: 25,
    call_arg_literals: 15,
    storage_keys: 15,
    type_refs: 20,
    base_types: 10,
    implements: 10,
    references: 10,
};
const COMPACT_DROP_ORDER = [
    'graph_text',
    'callsite_text',
    'references',
    'base_types',
    'implements',
    'imported_files',
];
function capString(s, max) {
    if (s === undefined)
        return s;
    const limit = max ?? 240;
    return s.length <= limit ? s : s.slice(0, limit - 1) + '\u2026';
}
export function compactSearchResult(row, snippetLines = 20, includeCodeLines = false, perResultByteBudget = 2200) {
    const { code_lines: codeLines, ...rest } = row;
    if (includeCodeLines) {
        return {
            ...row,
            has_more_content: false,
        };
    }
    const out = {
        ...rest,
        graph_text: capString(row.graph_text, COMPACT_FIELD_CHAR_CAPS.graph_text),
        callsite_text: capString(row.callsite_text, COMPACT_FIELD_CHAR_CAPS.callsite_text),
        preview: capString(row.preview, COMPACT_FIELD_CHAR_CAPS.preview) ?? '',
        snippet_lines: codeLines.slice(0, Math.max(0, snippetLines)),
        omitted_lines: Math.max(0, codeLines.length - snippetLines),
        has_more_content: codeLines.length > snippetLines,
    };
    for (const [k, cap] of Object.entries(COMPACT_ARRAY_CAPS)) {
        const arr = out[k];
        if (Array.isArray(arr) && arr.length > cap) {
            out[k] = arr.slice(0, cap);
        }
    }
    for (const field of COMPACT_DROP_ORDER) {
        if (Buffer.byteLength(JSON.stringify(out), 'utf8') <= perResultByteBudget)
            break;
        delete out[field];
    }
    return out;
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
function queryTokens(query) {
    return [...new Set(query
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .toLowerCase()
            .split(/[^a-z0-9_.$-]+/)
            .filter((t) => t.length >= 2))];
}
function classifyIntent(query) {
    const q = query.toLowerCase();
    if (/\b(localstorage|sessionstorage|indexeddb|cookie|storage key|browser storage|atomwithstorage|getitem|setitem|removeitem)\b/.test(q)) {
        return 'browser_storage';
    }
    return null;
}
function annotateSearchRows(rows, query) {
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
        const warnings = [];
        let possibleFalsePositive = false;
        let score = row.score ?? 0;
        if (intent === 'browser_storage') {
            const browserish = row.runtime === 'browser' || row.role === 'frontend' || row.language === 'tsx' || row.storage_keys.length > 0;
            const backendish = row.runtime === 'dotnet' || row.runtime === 'node' || row.role === 'backend' || row.language === 'csharp';
            if (browserish)
                score += 0.2;
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
    const fetchK = opts.rerank ? Math.max(opts.top_k * FUSION_MULTIPLIER, 40) : opts.top_k;
    const res = (await qdrant.query(COLLECTION, {
        prefetch: keywordPrefetches(opts.queryText, fetchK, opts.filter),
        query: { fusion: 'rrf' },
        limit: fetchK,
        with_payload: true,
    }));
    const rows = (res.points ?? []).map((pt) => ({
        ...payloadToResult(pt),
        score: 1.0,
        retrieval_channels: ['keyword'],
    }));
    return finalizeSearch(opts, rows);
}
async function searchHybrid(opts) {
    const vec = await opts.embed(opts.queryText);
    const fetchK = opts.rerank ? Math.max(opts.top_k * FUSION_MULTIPLIER, 40) : opts.top_k;
    const res = (await qdrant.query(COLLECTION, {
        prefetch: [
            { query: vec, using: '', limit: fetchK, filter: opts.filter },
            ...keywordPrefetches(opts.queryText, fetchK, opts.filter),
        ],
        query: { fusion: 'rrf' },
        limit: fetchK,
        with_payload: true,
    }));
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
async function finalizeSearch(opts, rows) {
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
        runtime: opts.runtime,
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
    const runMode = async (currentOpts) => {
        if (mode === 'semantic')
            return searchSemantic(currentOpts);
        if (mode === 'keyword')
            return searchKeyword(currentOpts);
        return searchHybrid(currentOpts);
    };
    const strict = await runMode(baseOpts);
    if (strict.length > 0)
        return strict;
    if (filter) {
        const relaxed = await runMode({ ...baseOpts, filter: undefined });
        if (relaxed.length > 0)
            return relaxed;
    }
    if (mode === 'keyword') {
        return searchHybrid({ ...baseOpts, filter: undefined });
    }
    return strict;
}
export async function wrFile(opts) {
    const offset = Math.max(0, opts.offset ?? 0);
    const limit = Math.min(Math.max(1, opts.limit ?? 20), 100);
    const contentMode = opts.contentMode ?? 'preview';
    const maxChars = Math.max(200, opts.maxChars ?? 2000);
    const res = (await qdrant.scroll(COLLECTION, {
        filter: { must: [{ key: 'file_path', match: { value: opts.path } }] },
        limit: 1000,
        with_payload: true,
        with_vector: false,
    }));
    const all = (res.points ?? [])
        .map((pt) => {
        const p = (pt.payload ?? {});
        const content = p.content ?? '';
        const base = {
            id: pt.id,
            chunk_index: p.chunk_index ?? 0,
            start_line: p.start_line ?? 0,
            end_line: p.end_line ?? 0,
            symbol_kind: p.symbol_kind ?? null,
            symbol_name: p.symbol_name ?? null,
            language: p.language ?? 'text',
            role: p.role ?? null,
            runtime: p.runtime ?? null,
            content_chars: content.length,
            line_count: content ? content.split(/\r?\n/).length : 0,
        };
        if (contentMode === 'full')
            base.content = content.slice(0, maxChars);
        if (contentMode === 'preview')
            base.preview = content.slice(0, Math.min(maxChars, 1000));
        return base;
    })
        .sort((a, b) => a.chunk_index - b.chunk_index);
    const chunks = all.slice(offset, offset + limit);
    const nextOffset = offset + chunks.length < all.length ? offset + chunks.length : null;
    return { chunks, next_offset: nextOffset, returned: chunks.length, content_mode: contentMode };
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
export async function wrCallArgs(opts) {
    const must = [];
    if (opts.path)
        must.push({ key: 'file_path', match: { value: opts.path } });
    if (opts.lang)
        must.push({ key: 'language', match: { value: opts.lang } });
    if (opts.literal)
        must.push({ key: 'call_arg_literals', match: { value: opts.literal } });
    if (opts.callee)
        must.push({ key: 'calls', match: { value: symbolName(opts.callee) } });
    const points = await scrollCollection(COLLECTION, must.length ? { must } : { must: [{ key: 'callsite_text', match: { text: opts.callee ?? opts.literal ?? '' } }] }, Math.min(opts.k ?? 50, 200));
    const out = [];
    for (const pt of points) {
        const p = (pt.payload ?? {});
        const sites = Array.isArray(p.call_sites) ? p.call_sites : [];
        for (const site of sites) {
            const compact = typeof site.compact_callee === 'string' ? site.compact_callee : undefined;
            if (opts.callee && compact !== symbolName(opts.callee))
                continue;
            const maps = Array.isArray(site.arg_literal_map) ? site.arg_literal_map : [];
            for (const m of maps) {
                const argIndex = typeof m.arg_index === 'number' ? m.arg_index : undefined;
                const literal = typeof m.literal === 'string' ? m.literal : undefined;
                if (opts.argIndex !== undefined && opts.argIndex !== null && argIndex !== opts.argIndex)
                    continue;
                if (opts.literal && literal !== opts.literal)
                    continue;
                out.push({
                    file_path: p.file_path,
                    line: typeof site.line === 'number' ? site.line : undefined,
                    callee: site.callee,
                    compact_callee: compact,
                    arg_index: argIndex,
                    literal,
                    literal_type: m.literal_type,
                    symbol_name: p.symbol_name ?? null,
                    code_span: site.code_span,
                });
            }
        }
    }
    const seen = new Set();
    return out.filter((row) => {
        const key = `${row.file_path}:${row.line}:${row.compact_callee}:${row.arg_index}:${row.literal}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    }).slice(0, opts.k ?? 50);
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
const SKILL_FUSION_MULTIPLIER = 4;
function skillsHashId(skillName, heading, filePath) {
    // Deterministic UUID-shaped id; mirrors python/indexer/db.py:_skills_point_id
    // so the two write paths collide on the same id (no duplicate points).
    const buf = createHash('sha1')
        .update('wr-skills::' + PROJECT_CONFIG.collectionName + '::' + skillName + '::' + heading + '::' + filePath)
        .digest();
    const hex = buf.subarray(0, 16).toString('hex');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-5' + hex.slice(13, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20, 32);
}
export async function wrSkillFind(opts) {
    const k = opts.k ?? 10;
    const vec = await opts.embed(opts.query);
    const must = [];
    if (opts.skill)
        must.push({ key: 'skill_name', match: { value: opts.skill } });
    if (opts.scope)
        must.push({ key: 'scope', match: { value: opts.scope } });
    if (opts.fileKind)
        must.push({ key: 'file_kind', match: { value: opts.fileKind } });
    const semanticFilter = must.length ? { must } : undefined;
    const keywordFilter = { must: [{ key: 'content', match: { text: opts.query } }, ...must] };
    const fetchK = Math.max(k * SKILL_FUSION_MULTIPLIER, 20);
    const res = (await qdrant.query(SKILLS_COLLECTION, {
        prefetch: [
            { query: vec, limit: fetchK, filter: semanticFilter },
            { filter: keywordFilter, limit: fetchK },
        ],
        query: { fusion: 'rrf' },
        limit: fetchK,
        with_payload: true,
    }));
    const points = res.points ?? [];
    return points.slice(0, k).map((pt) => {
        const p = (pt.payload ?? {});
        const content = typeof p.content === 'string' ? p.content : '';
        return {
            skill_name: typeof p.skill_name === 'string' ? p.skill_name : '',
            scope: typeof p.scope === 'string' ? p.scope : '',
            file_kind: typeof p.file_kind === 'string' ? p.file_kind : '',
            path: typeof p.path === 'string' ? p.path : '',
            heading: typeof p.heading === 'string' ? p.heading : '',
            description: typeof p.description === 'string' ? p.description : undefined,
            trigger: typeof p.trigger === 'string' ? p.trigger : undefined,
            preview: content.slice(0, 500),
            score: typeof pt.score === 'number' ? pt.score : 0,
        };
    });
}
function parseFrontmatter(raw) {
    const m = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/.exec(raw);
    if (!m || m[1] === undefined || m[2] === undefined)
        return { meta: {}, body: raw };
    const meta = {};
    for (const line of m[1].split(/\r?\n/)) {
        if (!line.trim() || line.trim().startsWith('#'))
            continue;
        const idx = line.indexOf(':');
        if (idx === -1)
            continue;
        const key = line.slice(0, idx).trim().toLowerCase();
        const val = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
        meta[key] = val;
    }
    return { meta, body: m[2] };
}
function chunkMarkdown(body) {
    const headingRe = /^(#{2,4})\s+(.+?)\s*$/gm;
    const matches = [];
    let m;
    while ((m = headingRe.exec(body)) !== null) {
        const title = (m[2] ?? '').trim();
        matches.push({ idx: m.index, title });
    }
    if (matches.length === 0) {
        const trimmed = body.trim();
        return trimmed ? [{ heading: '(intro)', content: trimmed }] : [];
    }
    const ranges = [];
    for (let i = 0; i < matches.length; i++) {
        const cur = matches[i];
        const next = i + 1 < matches.length ? matches[i + 1] : undefined;
        if (!cur)
            continue;
        const startLineEnd = body.indexOf('\n', cur.idx);
        const sliceStart = startLineEnd === -1 ? cur.idx : startLineEnd + 1;
        const sliceEnd = next ? next.idx : body.length;
        const content = body.slice(sliceStart, sliceEnd).trim();
        if (content)
            ranges.push({ heading: cur.title, content });
    }
    return ranges;
}
export async function wrSkillAdd(embed, input) {
    if (!input.path && !input.content) {
        throw new Error('wr_skill_add requires either `path` (abs file/dir) or `content` (inline markdown).');
    }
    if (input.path && input.content) {
        throw new Error('wr_skill_add accepts `path` OR `content`, not both.');
    }
    // ── inline path: single chunk
    if (input.content) {
        const skillName = (input.skill_name || 'inline').trim();
        const scope = input.scope ?? 'project';
        const fileKind = input.file_kind ?? 'skill';
        const heading = (input.heading || '(inline)').trim();
        const virtualPath = 'inline://' + skillName + '#' + heading;
        const vec = await embed(input.content);
        const id = skillsHashId(skillName, heading, virtualPath);
        await qdrant.upsert(SKILLS_COLLECTION, {
            points: [
                {
                    id,
                    vector: vec,
                    payload: {
                        skill_name: skillName,
                        scope,
                        file_kind: fileKind,
                        path: virtualPath,
                        description: input.description ?? '',
                        trigger: input.trigger ?? '',
                        heading,
                        content: input.content,
                    },
                },
            ],
            wait: true,
        });
        return { points_upserted: 1, ids: [id], skill_name: skillName, path: virtualPath };
    }
    // ── file/dir path: walk + chunk + embed + upsert
    const abs = path.resolve(input.path);
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const projectRoot = PROJECT_CONFIG.projectRoot;
    const allowedRoots = [path.resolve(projectRoot), path.resolve(home, '.claude')];
    const inAllowed = allowedRoots.some((r) => abs === r || abs.startsWith(r + path.sep));
    if (!inAllowed) {
        throw new Error('wr_skill_add: path ' + abs + ' is outside allowed roots (' +
            allowedRoots.join(', ') +
            '). Pass a path under <project>/.claude/ or ~/.claude/.');
    }
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat)
        throw new Error('wr_skill_add: path not found: ' + abs);
    const files = [];
    if (stat.isDirectory()) {
        const walk = async (dir) => {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const e of entries) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) {
                    if (e.name === 'node_modules' || e.name === '.git')
                        continue;
                    await walk(p);
                }
                else if (e.isFile() && p.endsWith('.md')) {
                    if (p.endsWith('SKILL.md') ||
                        p.includes(path.sep + 'references' + path.sep) ||
                        p.includes(path.sep + 'agents' + path.sep)) {
                        files.push(p);
                    }
                }
            }
        };
        await walk(abs);
    }
    else if (stat.isFile() && abs.endsWith('.md')) {
        files.push(abs);
    }
    else {
        throw new Error('wr_skill_add: ' + abs + ' is not a .md file or directory');
    }
    let totalUpserted = 0;
    const ids = [];
    let firstSkillName = '';
    for (const f of files) {
        const raw = await fs.readFile(f, 'utf8');
        const { meta, body } = parseFrontmatter(raw);
        const skillName = input.skill_name || meta.name || path.basename(path.dirname(f)) || path.basename(f, '.md');
        firstSkillName = firstSkillName || skillName;
        const scope = input.scope ?? (abs.includes(path.sep + '.claude' + path.sep) ? 'project' : 'global');
        const fileKind = input.file_kind ??
            (f.endsWith('SKILL.md')
                ? 'skill'
                : f.includes(path.sep + 'agents' + path.sep)
                    ? 'agent'
                    : 'reference');
        const description = input.description ?? meta.description ?? '';
        const trigger = input.trigger ?? meta.triggers ?? '';
        const chunks = chunkMarkdown(body);
        for (const c of chunks) {
            const vec = await embed(c.content);
            const id = skillsHashId(skillName, c.heading, f);
            await qdrant.upsert(SKILLS_COLLECTION, {
                points: [
                    {
                        id,
                        vector: vec,
                        payload: {
                            skill_name: skillName,
                            scope,
                            file_kind: fileKind,
                            path: f,
                            description,
                            trigger,
                            heading: c.heading,
                            content: c.content,
                        },
                    },
                ],
                wait: true,
            });
            ids.push(id);
            totalUpserted += 1;
        }
    }
    return { points_upserted: totalUpserted, ids, skill_name: firstSkillName, path: abs };
}
//# sourceMappingURL=tools.js.map