import { QdrantClient } from '@qdrant/js-client-rest';
import neo4j from 'neo4j-driver';
import { loadProjectConfig } from '../mcp-server/config.js';
import { deriveProjectIdentity } from '../installers/claude-bundle.js';
import { log } from '../utils/log.js';
import { exists } from '../utils/paths.js';
function asStringArray(value) {
    return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
}
function envConfig() {
    const cfg = loadProjectConfig();
    const uri = process.env[cfg.neo4j.uriEnv];
    const username = process.env[cfg.neo4j.userEnv];
    const password = process.env[cfg.neo4j.passwordEnv];
    const database = process.env[cfg.neo4j.databaseEnv];
    const missing = [
        [cfg.neo4j.uriEnv, uri],
        [cfg.neo4j.userEnv, username],
        [cfg.neo4j.passwordEnv, password],
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length)
        throw new Error(`Neo4j disabled: missing env vars ${missing.join(', ')}`);
    return { cfg, uri: uri ?? '', username: username ?? '', password: password ?? '', database };
}
async function createSchema(session) {
    await session.run('CREATE CONSTRAINT file_path IF NOT EXISTS FOR (f:File) REQUIRE f.path IS UNIQUE');
    await session.run('CREATE CONSTRAINT symbol_id IF NOT EXISTS FOR (s:Symbol) REQUIRE s.id IS UNIQUE');
    await session.run('CREATE CONSTRAINT name_value IF NOT EXISTS FOR (n:Name) REQUIRE n.name IS UNIQUE');
    await session.run('CREATE INDEX symbol_name IF NOT EXISTS FOR (s:Symbol) ON (s.name)');
    await session.run('CREATE INDEX symbol_fqn IF NOT EXISTS FOR (s:Symbol) ON (s.fqn)');
}
async function scrollPayloads(qdrant, collection, maxFiles) {
    const points = [];
    let offset;
    while (true) {
        const res = await qdrant.scroll(collection, {
            filter: { must: [{ key: 'symbol_index_version', match: { value: '1' } }] },
            limit: 256,
            offset,
            with_payload: true,
            with_vector: false,
        });
        for (const point of res.points ?? []) {
            points.push(point);
            if (maxFiles > 0 && new Set(points.map((p) => p.payload?.file_path)).size >= maxFiles)
                return points;
        }
        if (res.next_page_offset === undefined || res.next_page_offset === null)
            break;
        offset = res.next_page_offset;
    }
    return points;
}
async function syncChunk(session, payload) {
    const filePath = String(payload.file_path ?? '');
    if (!filePath)
        return;
    const language = String(payload.language ?? 'text');
    await session.run(`MERGE (f:File {path: $filePath})
     SET f.repo = $repo, f.language = $language`, { filePath, repo: String(payload.repo ?? ''), language });
    const names = asStringArray(payload.declared_symbols);
    const ids = asStringArray(payload.declared_symbol_ids);
    for (const [idx, name] of names.entries()) {
        const id = ids[idx] ?? `symbol:${filePath}:${name}`;
        await session.run(`MATCH (f:File {path: $filePath})
       MERGE (s:Symbol {id: $id})
       SET s.name = $name, s.fqn = coalesce($fqn, s.fqn, $name), s.kind = coalesce($kind, s.kind),
           s.file_path = $filePath, s.language = $language, s.start_line = coalesce($startLine, s.start_line),
           s.end_line = coalesce($endLine, s.end_line), s.signature = coalesce($signature, s.signature, '')
       MERGE (f)-[:DECLARES]->(s)`, {
            filePath,
            id,
            name,
            fqn: payload.symbol_fqn || null,
            kind: payload.symbol_kind || null,
            language,
            startLine: payload.start_line ?? null,
            endLine: payload.end_line ?? null,
            signature: payload.content ? String(payload.content).slice(0, 500) : '',
        });
    }
    for (const target of asStringArray(payload.imported_files)) {
        await session.run(`MATCH (f:File {path: $filePath})
       MERGE (t:File {path: $target})
       MERGE (f)-[:IMPORTS]->(t)`, { filePath, target });
    }
    for (const target of asStringArray(payload.imports)) {
        await session.run(`MATCH (f:File {path: $filePath})
       MERGE (m:Module {name: $target})
       MERGE (f)-[:IMPORTS]->(m)`, { filePath, target });
    }
    for (const target of asStringArray(payload.exports)) {
        await session.run(`MATCH (f:File {path: $filePath})
       MERGE (n:Name {name: $target})
       MERGE (f)-[:EXPORTS]->(n)`, { filePath, target });
    }
    for (const target of asStringArray(payload.calls)) {
        await session.run(`MATCH (f:File {path: $filePath})-[:DECLARES]->(s:Symbol)
       WHERE s.start_line <= $line AND $line <= s.end_line
       WITH s LIMIT 1
       MERGE (n:Name {name: $target})
       MERGE (s)-[:CALLS]->(n)`, { filePath, line: payload.start_line ?? 0, target });
    }
    for (const target of asStringArray(payload.base_types)) {
        await session.run(`MATCH (f:File {path: $filePath})-[:DECLARES]->(s:Symbol)
       WHERE s.start_line <= $line AND $line <= s.end_line
       WITH s LIMIT 1
       MERGE (n:Name {name: $target})
       MERGE (s)-[:EXTENDS]->(n)`, { filePath, line: payload.start_line ?? 0, target });
    }
    for (const target of asStringArray(payload.implements)) {
        await session.run(`MATCH (f:File {path: $filePath})-[:DECLARES]->(s:Symbol)
       WHERE s.start_line <= $line AND $line <= s.end_line
       WITH s LIMIT 1
       MERGE (n:Name {name: $target})
       MERGE (s)-[:IMPLEMENTS]->(n)`, { filePath, line: payload.start_line ?? 0, target });
    }
}
async function sync(driver, qdrant, collection, database, maxFiles) {
    const session = driver.session(database ? { database } : undefined);
    try {
        await createSchema(session);
        const points = await scrollPayloads(qdrant, collection, maxFiles);
        for (const point of points) {
            if (point.payload)
                await syncChunk(session, point.payload);
        }
        return new Set(points.map((p) => p.payload?.file_path).filter(Boolean)).size;
    }
    finally {
        await session.close();
    }
}
export async function runNeo4jSync(opts = {}) {
    const cwd = opts.cwd ?? process.cwd();
    const id = deriveProjectIdentity(cwd);
    if (!(await exists(id.configPath))) {
        throw new Error(`No wide-researcher config at ${id.configPath}.`);
    }
    process.argv.push('--project-config', id.configPath);
    const { cfg, uri, username, password, database } = envConfig();
    const driver = neo4j.driver(uri, neo4j.auth.basic(username, password));
    const qdrant = new QdrantClient({ url: cfg.qdrantUrl });
    try {
        log.step(`neo4j-sync ${id.projectName} (slug=${id.slug})`);
        const files = await sync(driver, qdrant, cfg.collectionName, database, opts.maxFiles ?? 0);
        log.ok(`neo4j-sync complete (${files} files)`);
    }
    finally {
        await driver.close();
    }
}
//# sourceMappingURL=neo4j-sync.js.map