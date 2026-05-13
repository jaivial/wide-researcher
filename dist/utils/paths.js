// Central path resolver for wide-researcher.
//
// Two scopes:
//   • global  — `~/.wide-researcher/` (one per machine)
//   • project — `<cwd>/.wide-researcher/` (one per project)
//
// Every installer + command imports from here; never hard-code paths
// anywhere else.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/* ── global (per machine) ───────────────────────────────────────────── */
export function globalRoot() {
    return path.join(os.homedir(), '.wide-researcher');
}
export function qdrantRoot() {
    return path.join(globalRoot(), 'qdrant');
}
export function qdrantBinary() {
    return path.join(qdrantRoot(), process.platform === 'win32' ? 'qdrant.exe' : 'qdrant');
}
export function qdrantConfigPath() {
    return path.join(qdrantRoot(), 'config.yaml');
}
export function qdrantStorageRoot() {
    return path.join(qdrantRoot(), 'storage');
}
export function modelsRoot() {
    return path.join(globalRoot(), 'models');
}
export function miniLMPath() {
    return path.join(modelsRoot(), 'all-MiniLM-L6-v2');
}
export function gteQwen2Path() {
    return path.join(modelsRoot(), 'gte-Qwen2-1.5B-instruct');
}
export function bgeLargePath() {
    return path.join(modelsRoot(), 'bge-large-en-v1.5');
}
export function venvRoot() {
    return path.join(globalRoot(), 'venv');
}
export function venvPython() {
    // Windows: `<venv>/Scripts/python.exe`. POSIX: `<venv>/bin/python`.
    const isWin = process.platform === 'win32';
    return path.join(venvRoot(), isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python');
}
export function venvPip() {
    const isWin = process.platform === 'win32';
    return path.join(venvRoot(), isWin ? 'Scripts' : 'bin', isWin ? 'pip.exe' : 'pip');
}
export function pyPackageRoot() {
    // bundled python tree shipped with the npm package
    // (resolves relative to the compiled JS in dist/)
    return path.resolve(__dirname, '..', '..', 'python');
}
export function templatesRoot() {
    return path.resolve(__dirname, '..', '..', 'templates');
}
export function logsRoot() {
    return path.join(globalRoot(), 'logs');
}
/* ── project (per cwd) ──────────────────────────────────────────────── */
export function projectRoot(cwd = process.cwd()) {
    return cwd;
}
export function projectConfigDir(cwd = process.cwd()) {
    return path.join(cwd, '.wide-researcher');
}
export function projectConfigPath(cwd = process.cwd()) {
    return path.join(projectConfigDir(cwd), 'config.json');
}
export function projectClaudeDir(cwd = process.cwd()) {
    return path.join(cwd, '.claude');
}
export function projectMcpPath(cwd = process.cwd()) {
    return path.join(cwd, '.mcp.json');
}
/* ── helpers ────────────────────────────────────────────────────────── */
export async function ensureDir(p) {
    await fs.mkdir(p, { recursive: true });
}
export async function exists(p) {
    try {
        await fs.access(p);
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=paths.js.map