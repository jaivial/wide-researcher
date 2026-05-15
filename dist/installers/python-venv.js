// Python venv installer.
//
// • Detects `python3.11` (preferred) / `python3.12` / `python3.13` /
//   `python3` (in that order). Fails fast if none ≥3.11 is found.
// • Creates `~/.wide-researcher/venv/` via `python -m venv`.
// • Installs everything in `python/requirements.txt` into the venv.
// • Idempotent: skips creation if the venv already exists AND every
//   required package imports successfully inside it.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { run, which } from '../utils/exec.js';
import { log } from '../utils/log.js';
import { ensureDir, exists, globalRoot, pyPackageRoot, venvPip, venvPython, venvRoot, } from '../utils/paths.js';
const PYTHON_CANDIDATES = process.platform === 'win32'
    ? ['python', 'python3', 'py'] // `py` is the Windows launcher
    : ['python3.13', 'python3.12', 'python3.11', 'python3'];
const MIN_PY = [3, 11];
async function findSystemPython() {
    for (const cand of PYTHON_CANDIDATES) {
        const found = await which(cand);
        if (!found)
            continue;
        try {
            const r = await run(found, ['-c', 'import sys; print(sys.version_info[0], sys.version_info[1])'], {
                capture: true,
            });
            const parts = r.stdout.trim().split(/\s+/).map((x) => parseInt(x, 10));
            const maj = parts[0] ?? NaN;
            const min = parts[1] ?? NaN;
            const minMaj = MIN_PY[0] ?? 3;
            const minMin = MIN_PY[1] ?? 11;
            if (Number.isFinite(maj) &&
                Number.isFinite(min) &&
                (maj > minMaj || (maj === minMaj && min >= minMin))) {
                log.info(`found python ${maj}.${min} at ${found}`);
                return found;
            }
        }
        catch {
            // try next candidate
        }
    }
    throw new Error(`wide-researcher needs Python ≥ ${MIN_PY[0]}.${MIN_PY[1]}. None found on PATH.\n` +
        '  Install via your package manager:\n' +
        '    Debian/Ubuntu: sudo apt install python3.11 python3.11-venv\n' +
        '    macOS:         brew install python@3.11\n' +
        '    Arch:          sudo pacman -S python python-virtualenv');
}
async function venvIsHealthy() {
    if (!(await exists(venvPython())))
        return false;
    try {
        // Quick probe — import every package the indexer needs.
        await run(venvPython(), [
            '-c',
            'import qdrant_client, sentence_transformers, torch, tree_sitter, ' +
                'tree_sitter_languages, huggingface_hub, watchdog, requests, cohere',
        ], { capture: true });
        return true;
    }
    catch {
        return false;
    }
}
export async function installPythonVenv(opts = {}) {
    await ensureDir(globalRoot());
    if (!opts.force && (await venvIsHealthy())) {
        log.skip(`python venv already healthy at ${venvRoot()}`);
        return;
    }
    if (opts.force && (await exists(venvRoot()))) {
        log.info(`removing existing venv (--force)`);
        await fs.rm(venvRoot(), { recursive: true, force: true });
    }
    const py = await findSystemPython();
    log.step(`creating python venv at ${venvRoot()}`);
    if (!(await exists(venvPython()))) {
        await run(py, ['-m', 'venv', venvRoot()], { echo: true });
    }
    log.step('upgrading pip + wheel');
    await run(venvPython(), ['-m', 'pip', 'install', '--upgrade', 'pip', 'wheel'], { echo: true });
    const requirements = path.join(pyPackageRoot(), 'requirements.txt');
    if (!(await exists(requirements))) {
        throw new Error(`requirements.txt missing at ${requirements}`);
    }
    log.step('installing python dependencies (this takes a minute or two)');
    await run(venvPip(), ['install', '-r', requirements], { echo: true });
    if (!(await venvIsHealthy())) {
        throw new Error(`venv created but health-check failed. Inspect ${venvRoot()} and re-run with --force.`);
    }
    log.ok(`python venv ready at ${venvRoot()}`);
}
//# sourceMappingURL=python-venv.js.map