import { type InitOptions } from './init.js';
export type AddOptions = Omit<InitOptions, 'onlyProject'>;
export declare function runAdd(opts?: AddOptions): Promise<void>;
