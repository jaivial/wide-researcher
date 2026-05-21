import { type Session } from 'neo4j-driver';
import type { ProjectConfig } from './config.js';
export interface GraphChunk {
    id: string | number;
    file_path?: string;
    start_line?: number;
    end_line?: number;
    language?: string;
    symbol_kind?: string | null;
    symbol_name?: string | null;
    declared_symbols: string[];
    imports: string[];
    imported_files: string[];
    exports: string[];
    calls: string[];
    type_refs: string[];
    base_types: string[];
    implements: string[];
    references: string[];
    preview: string;
    code_lines: Array<{
        line: number;
        text: string;
    }>;
    score: number | null;
}
export declare function neo4jConfigError(cfg: ProjectConfig): string | null;
export declare function neo4jEnabled(cfg: ProjectConfig): boolean;
export declare function withNeo4jSession<T>(cfg: ProjectConfig, fn: (session: Session) => Promise<T>): Promise<T>;
export declare function closeNeo4j(): Promise<void>;
export declare function neo4jCallers(cfg: ProjectConfig, symbol: string, k: number): Promise<GraphChunk[]>;
export declare function neo4jCallees(cfg: ProjectConfig, symbolOrFile: string, k: number): Promise<{
    calls: string[];
    chunks: GraphChunk[];
}>;
export declare function neo4jImporters(cfg: ProjectConfig, pathOrModule: string, k: number): Promise<GraphChunk[]>;
export declare function neo4jExports(cfg: ProjectConfig, filePath: string, k: number): Promise<{
    exports: string[];
    chunks: GraphChunk[];
}>;
