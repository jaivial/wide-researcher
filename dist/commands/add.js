// `wide-researcher add` — add wide-researcher to a project on a
// machine that already has the global infra. Thin wrapper around
// `init({onlyProject: true})`.
import { runInit } from './init.js';
export async function runAdd(opts = {}) {
    await runInit({ ...opts, onlyProject: true });
}
//# sourceMappingURL=add.js.map