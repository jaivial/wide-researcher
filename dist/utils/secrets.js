// Secure storage for API keys at `~/.wide-researcher/secrets.json`.
//
// File is created with mode 600 (owner read/write only). Directory
// is mode 700. On Windows the chmod is best-effort; NTFS ACL is the
// real protection (inherits from the parent user dir).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensureDir, exists, globalRoot } from './paths.js';
function secretsPath() {
    return path.join(globalRoot(), 'secrets.json');
}
async function readAll() {
    if (!(await exists(secretsPath())))
        return {};
    try {
        const raw = await fs.readFile(secretsPath(), 'utf8');
        const doc = JSON.parse(raw);
        return doc ?? {};
    }
    catch {
        return {};
    }
}
async function writeAll(doc) {
    await ensureDir(globalRoot());
    // Tighten dir mode (no-op on Windows)
    try {
        await fs.chmod(globalRoot(), 0o700);
    }
    catch {
        /* ignore */
    }
    await fs.writeFile(secretsPath(), JSON.stringify(doc, null, 2) + '\n', 'utf8');
    try {
        await fs.chmod(secretsPath(), 0o600);
    }
    catch {
        /* ignore — Windows */
    }
}
export async function getSecret(key) {
    const doc = await readAll();
    return doc[key];
}
export async function setSecret(key, value) {
    const doc = await readAll();
    doc[key] = value;
    await writeAll(doc);
}
export async function deleteSecret(key) {
    const doc = await readAll();
    delete doc[key];
    await writeAll(doc);
}
export function secretsFilePath() {
    return secretsPath();
}
//# sourceMappingURL=secrets.js.map