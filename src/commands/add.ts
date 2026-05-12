// `wide-researcher add` — add wide-researcher to a project on a
// machine that already has the global infra. Thin wrapper around
// `init({onlyProject: true})`.

import { runInit, type InitOptions } from './init.js';

export type AddOptions = Omit<InitOptions, 'onlyProject'>;

export async function runAdd(opts: AddOptions = {}): Promise<void> {
  await runInit({ ...opts, onlyProject: true });
}
