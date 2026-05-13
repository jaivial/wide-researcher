#!/usr/bin/env python3
"""One-file-per-subprocess bulk reindex — impossible to OOM.

Spawns `python -m indexer file <path>` for each file that needs
(re)indexing. When the subprocess exits the kernel reclaims ALL
its memory — leaks are structurally impossible.

Slower than batching (~1 s startup per file) but on a RAM-constrained
host this is the only safe approach.

## Usage

  python -m scripts.bulk_reindex                     # hash-skip, 1 file/subprocess
  python -m scripts.bulk_reindex --force             # re-embed everything
  python -m scripts.reindex --resume-from N          # skip first N files
  python -m scripts.bulk_reindex --max-files N       # stop after N (testing)
"""
from __future__ import annotations

import argparse
import logging
import os
import subprocess
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
_PY_ROOT = os.path.dirname(_HERE)
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

from indexer.config import PROJECT_ROOT  # noqa: E402
from indexer.walk import iter_files  # noqa: E402
from indexer.db import get_indexed_files, compute_file_hash  # noqa: E402

log = logging.getLogger("bulk-reindex")


def _read_hash(abs_path: str) -> str | None:
    try:
        with open(abs_path, "rb") as f:
            return compute_file_hash(f.read())
    except OSError:
        return None


def _index_one(abs_path: str, env: dict) -> str:
    """Spawn `python -m indexer file <path>`, return 'ok'|'err'|'skip'."""
    try:
        result = subprocess.run(
            [sys.executable, "-m", "indexer", "file", abs_path],
            capture_output=True,
            text=True,
            timeout=600,       # 10 min per file — bge-large on CPU can be slow
            env=env,
            cwd=_PY_ROOT,
        )
    except subprocess.TimeoutExpired:
        log.warning("TIMEOUT indexing %s", abs_path)
        return "err"
    if result.returncode != 0:
        log.warning("FAIL (%d) %s: %s", result.returncode, abs_path, result.stderr[:300])
        return "err"
    line = (result.stdout or "").strip().splitlines()[-1] if result.stdout else ""
    if line.startswith("skipped:"):
        return "skip"
    return "ok"


def main() -> int:
    ap = argparse.ArgumentParser(prog="bulk-reindex")
    ap.add_argument("--force", action="store_true",
                    help="Skip hash cache; re-embed every file")
    ap.add_argument("--resume-from", type=int, default=0,
                    help="Skip the first N files (resume after interruption)")
    ap.add_argument("--max-files", type=int, default=0,
                    help="Process at most N files then exit (testing)")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    env = dict(os.environ)
    if "WIDE_RESEARCHER_PROJECT_CONFIG" not in env:
        log.error("WIDE_RESEARCHER_PROJECT_CONFIG not set")
        return 1

    log.info("walking %s", PROJECT_ROOT)
    files = [abs_path for _, abs_path, _ in iter_files([PROJECT_ROOT])]
    log.info("discovered %d candidate files", len(files))

    # Hash-skip pass
    indexed_hashes = {} if args.force else get_indexed_files()
    to_process: list[str] = []
    if not args.force:
        for abs_path in files:
            current_hash = _read_hash(abs_path)
            if current_hash is None:
                continue
            if indexed_hashes.get(abs_path) != current_hash:
                to_process.append(abs_path)
        log.info("after hash-skip: %d files need (re)indexing", len(to_process))
    else:
        to_process = files

    if args.resume_from:
        to_process = to_process[args.resume_from:]
        log.info("resumed at offset %d; %d files remain", args.resume_from, len(to_process))

    if args.max_files:
        to_process = to_process[: args.max_files]
        log.info("--max-files=%d limit applied", args.max_files)

    if not to_process:
        log.info("nothing to do")
        return 0

    total_ok = total_err = total_skp = 0
    t_start = time.time()
    n = len(to_process)

    for i, abs_path in enumerate(to_process):
        # ── System memory guard ──────────────────────────────────
        try:
            with open("/proc/meminfo", "r") as f:
                for line in f:
                    if line.startswith("MemAvailable:"):
                        avail_kb = int(line.split()[1])
                        break
            avail_gb = avail_kb / 1024 / 1024
            if avail_gb < 0.5:
                log.warning("low memory (%.1f GB) — pausing 30 s", avail_gb)
                time.sleep(30)
        except Exception:
            pass

        result = _index_one(abs_path, env)

        if result == "ok":
            total_ok += 1
        elif result == "skip":
            total_skp += 1
        else:
            total_err += 1

        elapsed = time.time() - t_start
        done = i + 1
        rate = done / max(elapsed, 0.001)
        eta = (n - done) / max(rate, 0.001)
        if done % 10 == 0 or result == "err":
            log.info("[%d/%d] ok=%d err=%d skp=%d · %.1f f/s · ETA %.0fs · %s",
                     done, n, total_ok, total_err, total_skp, rate, eta,
                     os.path.relpath(abs_path, PROJECT_ROOT))

    elapsed = time.time() - t_start
    print(f"done. indexed={total_ok} skipped={total_skp} errors={total_err} elapsed={elapsed:.1f}s")
    return 0 if total_err == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
