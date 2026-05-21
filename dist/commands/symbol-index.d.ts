export interface SymbolIndexOptions {
    cwd?: string;
    force?: boolean;
    maxFiles?: number;
    nodeEmbeddings?: boolean;
}
export declare function runSymbolIndex(opts?: SymbolIndexOptions): Promise<void>;
