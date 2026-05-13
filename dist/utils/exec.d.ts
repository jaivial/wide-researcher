import { type SpawnOptions } from 'node:child_process';
export interface RunOptions extends SpawnOptions {
    /** When true, capture stdout/stderr instead of streaming. */
    capture?: boolean;
    /** Echo the command being run to stderr before spawning. */
    echo?: boolean;
}
export interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
}
export declare function run(cmd: string, args?: string[], opts?: RunOptions): Promise<RunResult>;
export declare function which(cmd: string): Promise<string | null>;
