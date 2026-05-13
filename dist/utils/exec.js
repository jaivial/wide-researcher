// Small spawn wrapper that streams stdout/stderr to the parent process
// and rejects on non-zero exit. Used by every installer.
import { spawn } from 'node:child_process';
export async function run(cmd, args = [], opts = {}) {
    const { capture, echo, stdio, ...rest } = opts;
    if (echo) {
        process.stderr.write(`$ ${cmd} ${args.join(' ')}\n`);
    }
    return await new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
            ...rest,
            stdio: capture ? ['ignore', 'pipe', 'pipe'] : stdio ?? 'inherit',
        });
        let out = '';
        let err = '';
        child.stdout?.on('data', (b) => {
            out += b.toString('utf8');
        });
        child.stderr?.on('data', (b) => {
            err += b.toString('utf8');
        });
        child.on('error', (e) => reject(e));
        child.on('close', (code) => {
            const result = { code: code ?? -1, stdout: out, stderr: err };
            if ((code ?? -1) !== 0) {
                const e = new Error(`${cmd} ${args.join(' ')} exited ${code}${err ? `\n${err}` : ''}`);
                e.result = result;
                reject(e);
                return;
            }
            resolve(result);
        });
    });
}
export async function which(cmd) {
    try {
        const r = await run('which', [cmd], { capture: true });
        return r.stdout.trim() || null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=exec.js.map