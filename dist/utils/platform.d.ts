export type SupportedOs = 'linux' | 'macos' | 'windows';
export type SupportedArch = 'x86_64' | 'aarch64';
export interface PlatformInfo {
    os: SupportedOs;
    arch: SupportedArch;
    /** Qdrant release asset target triple, e.g. `x86_64-unknown-linux-gnu`. */
    qdrantTriple: string;
    /** Qdrant release archive extension (`tar.gz` on POSIX, `zip` on Windows). */
    qdrantArchiveExt: 'tar.gz' | 'zip';
    /** Whether `process.platform === 'win32'`. */
    isWindows: boolean;
}
export declare function detectPlatform(): PlatformInfo;
export declare function hasSystemd(): boolean;
export declare function hasLaunchd(): boolean;
export declare function isWindows(): boolean;
export declare function cpuCount(): number;
