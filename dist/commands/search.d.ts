export interface SearchOptions {
    cwd?: string;
    mode?: 'semantic' | 'keyword' | 'hybrid';
    topK?: number;
}
export declare function runSearch(query: string, opts?: SearchOptions): Promise<void>;
