type EmbedFn = (text: string) => Promise<number[]>;
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
    code_lines: Array<{
        line: number;
        text: string;
    }>;
    score: number | null;
}
export interface FindOpts {
    embed: EmbedFn;
    query: string;
    k?: number;
    lang?: string | null;
    role?: string | null;
    layer?: string | null;
    mode?: 'semantic' | 'keyword' | 'hybrid';
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
    content: string;
}
export declare function wrFile(opts: {
    path: string;
}): Promise<FileChunk[]>;
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
    query: string;
    k?: number;
    kind?: string | null;
    lang?: string | null;
}): Promise<SymbolSearchResult[]>;
export declare function wrCallers(opts: {
    symbol: string;
    k?: number;
}): Promise<SearchResult[]>;
export declare function wrCallees(opts: {
    symbolOrFile: string;
    k?: number;
}): Promise<{
    calls: string[];
    chunks: SearchResult[];
}>;
export declare function wrImporters(opts: {
    pathOrModule: string;
    k?: number;
}): Promise<SearchResult[]>;
export declare function wrExports(opts: {
    path: string;
    k?: number;
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
    description: string;
    k?: number;
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
    description: string;
    k?: number;
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
export declare function wrIndexStatus(): Promise<IndexStatus>;
export {};
