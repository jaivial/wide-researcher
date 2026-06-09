type EmbedFn = (text: string) => Promise<number[]>;
type RerankFn = (query: string, docs: string[]) => Promise<number[]>;
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
    code_lines: Array<{
        line: number;
        text: string;
    }>;
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
    snippet_lines?: Array<{
        line: number;
        text: string;
    }>;
    omitted_lines?: number;
    has_more_content: boolean;
}
export declare function compactSearchResult(row: SearchResult, snippetLines?: number, includeCodeLines?: boolean, perResultByteBudget?: number): SearchResult | CompactSearchResult;
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
    collection?: string | null;
}
export declare function wrFind(opts: FindOpts): Promise<SearchResult[]>;
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
export declare function wrFile(opts: {
    path: string;
    offset?: number;
    limit?: number;
    contentMode?: 'none' | 'preview' | 'full';
    maxChars?: number;
    collection?: string | null;
}): Promise<FileResult>;
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
export declare function wrSymbolFind(opts: {
    embed: EmbedFn;
    rerank?: RerankFn;
    query: string;
    k?: number;
    kind?: string | null;
    lang?: string | null;
    collection?: string | null;
}): Promise<SymbolSearchResult[]>;
export declare function wrCallers(opts: {
    symbol: string;
    k?: number;
    collection?: string | null;
}): Promise<SearchResult[]>;
export declare function wrCallees(opts: {
    symbolOrFile: string;
    k?: number;
    collection?: string | null;
}): Promise<{
    calls: string[];
    chunks: SearchResult[];
}>;
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
export declare function wrCallArgs(opts: {
    callee?: string | null;
    argIndex?: number | null;
    literal?: string | null;
    lang?: string | null;
    path?: string | null;
    k?: number;
    collection?: string | null;
}): Promise<CallArgResult[]>;
export declare function wrImporters(opts: {
    pathOrModule: string;
    k?: number;
    collection?: string | null;
}): Promise<SearchResult[]>;
export declare function wrExports(opts: {
    path: string;
    k?: number;
    collection?: string | null;
}): Promise<{
    exports: string[];
    chunks: SearchResult[];
}>;
export interface ArchImpactFile {
    path: string;
    score: number;
    reasons: string[];
    top_symbols: string[];
    edges: Array<{
        kind: string;
        target: string;
        line?: number;
    }>;
    source: string[];
}
export declare function wrArchImpact(opts: {
    embed: EmbedFn;
    rerank?: RerankFn;
    description: string;
    k?: number;
    collection?: string | null;
}): Promise<ArchImpactFile[]>;
export interface ImpactFile {
    file_path: string;
    language: string;
    role: string | null;
    total_score: number;
    chunk_count_in_results: number;
    top_symbols: string[];
}
export declare function wrImpact(opts: {
    embed: EmbedFn;
    rerank?: RerankFn;
    description: string;
    k?: number;
    collection?: string | null;
}): Promise<ImpactFile[]>;
export interface IndexStatus {
    collection: string;
    status: string;
    points_count: number;
    vectors_count?: number;
    indexed_vectors_count?: number;
    vector_size?: number;
    distance?: string;
}
export declare function wrIndexStatus(collection?: string | null): Promise<IndexStatus>;
export interface CollectionInfo {
    name: string;
    is_default: boolean;
    status: string;
    points_count: number;
    vector_size?: number;
    distance?: string;
}
/**
 * List every Qdrant collection on the server, with health/size detail.
 * Use to discover which `collection` value to pass to other tools.
 * `filter` is an optional case-insensitive substring on the name.
 */
export declare function wrCollections(opts?: {
    filter?: string | null;
}): Promise<{
    default_collection: string;
    count: number;
    collections: CollectionInfo[];
}>;
export interface MemorySearchResult {
    id: string | number;
    title: string;
    summary: string;
    kind?: string;
    tags: string[];
    files: string[];
    learned_at?: string;
    resolved?: boolean;
    preview: string;
    score: number | null;
}
export declare function wrMemoriesFind(opts: {
    embed: EmbedFn;
    query?: string;
    k?: number;
}): Promise<MemorySearchResult[]>;
export interface MemoryAddInput {
    title: string;
    content: string;
    summary?: string;
    kind?: string;
    tags?: string[];
    files?: string[];
    learned_at?: string;
    resolved?: boolean;
}
export interface MemoryAddResult {
    points_upserted: number;
    id: string;
    title: string;
}
export declare function wrMemoryAdd(embed: (text: string) => Promise<number[]>, input: MemoryAddInput): Promise<MemoryAddResult>;
export interface SkillSearchResult {
    skill_name: string;
    scope: string;
    file_kind: string;
    path: string;
    heading: string;
    description?: string;
    trigger?: string;
    preview: string;
    score: number;
}
export declare function wrSkillFind(opts: {
    embed: (text: string) => Promise<number[]>;
    query: string;
    k?: number;
    skill?: string | null;
    scope?: 'project' | 'global' | null;
    fileKind?: 'skill' | 'agent' | 'reference' | null;
    collection?: string | null;
}): Promise<SkillSearchResult[]>;
export interface SkillAddInput {
    path?: string;
    content?: string;
    skill_name?: string;
    description?: string;
    trigger?: string;
    file_kind?: 'skill' | 'agent' | 'reference';
    scope?: 'project' | 'global';
    heading?: string;
}
export interface SkillAddResult {
    points_upserted: number;
    ids: string[];
    skill_name: string;
    path: string;
}
export declare function wrSkillAdd(embed: (text: string) => Promise<number[]>, input: SkillAddInput): Promise<SkillAddResult>;
export {};
