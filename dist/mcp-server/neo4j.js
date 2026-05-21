import neo4j from 'neo4j-driver';
let driver = null;
export function neo4jConfigError(cfg) {
    if (cfg.graphProvider !== 'neo4j')
        return null;
    const missing = [cfg.neo4j.uriEnv, cfg.neo4j.userEnv, cfg.neo4j.passwordEnv].filter((name) => !process.env[name]);
    if (missing.length)
        return `graph_provider=neo4j but missing env vars: ${missing.join(', ')}`;
    return null;
}
export function neo4jEnabled(cfg) {
    return cfg.graphProvider === 'neo4j' && neo4jConfigError(cfg) === null;
}
function getDriver(cfg) {
    const err = neo4jConfigError(cfg);
    if (err)
        throw new Error(err);
    if (!driver) {
        driver = neo4j.driver(process.env[cfg.neo4j.uriEnv] ?? '', neo4j.auth.basic(process.env[cfg.neo4j.userEnv] ?? '', process.env[cfg.neo4j.passwordEnv] ?? ''));
    }
    return driver;
}
export async function withNeo4jSession(cfg, fn) {
    const database = process.env[cfg.neo4j.databaseEnv];
    const session = getDriver(cfg).session(database ? { database } : undefined);
    try {
        return await fn(session);
    }
    finally {
        await session.close();
    }
}
export async function closeNeo4j() {
    if (!driver)
        return;
    await driver.close();
    driver = null;
}
function nodeToChunk(node, source) {
    const startLine = typeof node.start_line === 'number' ? node.start_line : 1;
    return {
        id: String(node.id ?? `${node.file_path ?? ''}:${node.name ?? ''}`),
        file_path: node.file_path,
        start_line: node.start_line,
        end_line: node.end_line,
        language: node.language,
        symbol_kind: node.kind ?? null,
        symbol_name: node.name ?? null,
        declared_symbols: node.name ? [String(node.name)] : [],
        imports: [],
        imported_files: [],
        exports: [],
        calls: source === 'caller' ? [] : [],
        type_refs: [],
        base_types: [],
        implements: [],
        references: [],
        preview: String(node.signature ?? ''),
        code_lines: String(node.signature ?? '').split(/\r?\n/).map((text, idx) => ({ line: startLine + idx, text })),
        score: 1.0,
    };
}
export async function neo4jCallers(cfg, symbol, k) {
    return withNeo4jSession(cfg, async (session) => {
        const res = await session.run(`MATCH (caller:Symbol)-[:CALLS]->(target)
       WHERE target.name = $symbol OR target.fqn = $symbol
       RETURN caller LIMIT $k`, { symbol, k: neo4j.int(k) });
        return res.records.map((record) => nodeToChunk(record.get('caller').properties, 'caller'));
    });
}
export async function neo4jCallees(cfg, symbolOrFile, k) {
    return withNeo4jSession(cfg, async (session) => {
        const res = symbolOrFile.startsWith('/')
            ? await session.run(`MATCH (file:File {path: $value})-[:DECLARES]->(source:Symbol)-[:CALLS]->(target)
           RETURN source, collect(DISTINCT coalesce(target.fqn, target.name)) AS calls LIMIT $k`, { value: symbolOrFile, k: neo4j.int(k) })
            : await session.run(`MATCH (source:Symbol)-[:CALLS]->(target)
           WHERE source.name = $value OR source.fqn = $value
           RETURN source, collect(DISTINCT coalesce(target.fqn, target.name)) AS calls LIMIT $k`, { value: symbolOrFile, k: neo4j.int(k) });
        const chunks = res.records.map((record) => nodeToChunk(record.get('source').properties, 'callee'));
        const calls = [...new Set(res.records.flatMap((record) => record.get('calls')))];
        return { calls, chunks };
    });
}
export async function neo4jImporters(cfg, pathOrModule, k) {
    return withNeo4jSession(cfg, async (session) => {
        const res = await session.run(`MATCH (file:File)-[:IMPORTS]->(target)
       WHERE target.path = $value OR target.name = $value
       RETURN file LIMIT $k`, { value: pathOrModule, k: neo4j.int(k) });
        return res.records.map((record) => {
            const file = record.get('file').properties;
            return {
                ...nodeToChunk({ file_path: file.path, language: file.language, name: file.path, signature: '' }, 'importer'),
                imports: [pathOrModule],
            };
        });
    });
}
export async function neo4jExports(cfg, filePath, k) {
    return withNeo4jSession(cfg, async (session) => {
        const res = await session.run(`MATCH (:File {path: $filePath})-[:EXPORTS]->(target)
       RETURN collect(DISTINCT coalesce(target.fqn, target.name)) AS exports LIMIT $k`, { filePath, k: neo4j.int(k) });
        const exports = res.records[0]?.get('exports') ?? [];
        return { exports, chunks: [] };
    });
}
//# sourceMappingURL=neo4j.js.map