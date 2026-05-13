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
    preview: string;
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
