export declare function ask(question: string, fallback?: string): Promise<string>;
/** Hide echoed characters while user types. Used for API keys. */
export declare function askSecret(question: string): Promise<string>;
export interface SelectChoice<T extends string> {
    value: T;
    label: string;
    description?: string;
}
/** Numbered selection (cross-platform; no ANSI cursor manipulation). */
export declare function select<T extends string>(title: string, choices: SelectChoice<T>[], defaultIndex?: number): Promise<T>;
