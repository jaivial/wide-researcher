#!/usr/bin/env python3
"""Subprocess-per-batch bulk reindex — RAM-safe at any scale.

Standard `python -m indexer reindex` runs everything in one Python
process. With Cohere v4 or MiniLM, that process can leak gigabytes
over thousands of files (httpx connection pool, pydantic responses,
PyTorch buffers). On a 500k-file repo it OOMs reliably.

This script solves it by spawning a fresh `python -m indexer file
<path>` subprocess for each batch of N files. When the subprocess
exits, the kernel reclaims ALL its memory — leak is impossible to
accumulate across batches.

## Trade-off

- Slower: ~1 s Python startup per batch (vs zero for in-process).
  At batch=50, that's ~2% overhead.
- Safer: process RSS stays bounded by per-batch peak (~500 MB on
  Cohere, ~1.5 GB on local-minilm with model load).

## Usage

  python -m scripts.bulk_reindex                     # default batch=50
  python -m scripts.bulk_reindex --batch 100         # larger = faster, more RAM
  python -m scripts.bulk_reindex --force             # ignore hash cache
  python -m scripts.bulk_reindex --resume-from N     # skip first N files
  python -m scripts.bulk_reindex --max-files N       # stop after N (testing)
"""
from __future__ import annotations

import argparse
import logging
import os
import subprocess
import sys
import time
from pathlib import Path

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


def _run_batch(batch: list[str], force: bool) -> tuple[int, int, int]:
    """Spawn one subprocess to index `batch` files. Returns (ok, err, skip)."""
    if not batch:
        return (0, 0, 0)

    # We can't pass N file paths to a single `python -m indexer file <path>`
    # call (only takes ONE path). Loop inside the subprocess by calling
    # it via a small inline runner that processes a stdin list.
    env = dict(os.environ)
    # Make sure subprocess loads same config.
    if "WIDE_RESEARCHER_PROJECT_CONFIG" not in env:
        log.error("WIDE_RESEARCHER_PROJECT_CONFIG not set in environment")
        return (0, len(batch), 0)

    # Build a small inline driver: read paths from stdin, call indexer.cli's
    # _process_file equivalent per path, then exit. This way ONE subprocess
    # handles N files but exits cleanly + frees memory before next batch.
    driver = (
        "import os, sys\n"
        f"sys.path.insert(0, {_PY_ROOT!r})\n"
        "from indexer.cli import _process_file\n"
        "from indexer.embed import get_model\n"
        "from indexer.walk import LANG_BY_SUFFIX, EXACT_FILENAME_LANG\n"
        "get_model()  # warm up backend\n"
        "ok = err = skp = 0\n"
        "for line in sys.stdin:\n"
        "    line = line.strip()\n"
        "    if not line:\n"
        "        continue\n"
        "    abs_path, force_str = line.rsplit(' ', 1)\n"
        "    force = force_str == '1'\n"
        "    ext = os.path.splitext(abs_path)[1].lower()\n"
        "    basename = os.path.basename(abs_path)\n"
        "    language = EXACT_FILENAME_LANG.get(basename) or LANG_BY_SUFFIX.get(ext, 'text')\n"
        "    status, _ = _process_file(None, abs_path, 'project', language, None, force, False)\n"
        "    if status == 'indexed': ok += 1\n"
        "    elif status == 'skipped': skp += 1\n"
        "    else: err += 1\n"
        "print(f'batch-result ok={ok} err={err} skp={skp}')\n"
    )

    proc_input = "\n".join(f"{p} {'1' if force else '0'}" for p in batch) + "\n"
    try:
        result = subprocess.run(
            [sys.executable, "-c", driver],
            input=proc_input,
            capture_output=True,
            text=True,
            timeout=600,  # 10 min per batch — generous
            env=env,
            cwd=_PY_ROOT,
        )
    except subprocess.TimeoutExpired:
        log.warning("batch timeout (>600 s)")
        return (0, len(batch), 0)
    if result.returncode != 0:
        log.warning("batch subprocess returned %d: %s", result.returncode, result.stderr[:500])
        return (0, len(batch), 0)
    # Parse the last "batch-result" line
    ok = err = skp = 0
    for line in result.stdout.splitlines():
        if line.startswith("batch-result"):
            parts = dict(p.split("=") for p in line.split() if "=" in p)
            try:
                ok = int(parts.get("ok", 0))
                err = int(parts.get("err", 0))
                skp = int(parts.get("skp", 0))
            except ValueError:
                pass
            break
    return (ok, err, skp)


def main() -> int:
    ap = argparse.ArgumentParser(prog="bulk-reindex")
    ap.add_argument("--batch", type=int, default=50,
                    help="Files per subprocess (default 50; lower = safer / slower)")
    ap.add_argument("--force", action="store_true",
                    help="Skip hash cache; re-embed every file")
    ap.add_argument("--resume-from", type=int, default=0,
                    help="Skip the first N files (resume after interruption)")
    ap.add_argument("--max-files", type=int, default=0,
                    help="Process at most N files then exit (testing)")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    log.info("walking %s", PROJECT_ROOT)
    files = [abs_path for _, abs_path, _ in iter_files([PROJECT_ROOT])]
    log.info("discovered %d candidate files", len(files))

    # Hash-skip pass up front so we don't even spawn for already-indexed files.
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
    for i in range(0, n, args.batch):
        batch = to_process[i : i + args.batch]
        log.info("batch %d/%d (%d files) — files %d..%d",
                  (i // args.batch) + 1,
                  (n + args.batch - 1) // args.batch,
                  len(batch), i, i + len(batch) - 1)
        ok, err, skp = _run_batch(batch, args.force)
        total_ok += ok
        total_err += err
        total_skp += skp
        elapsed = time.time() - t_start
        rate = (total_ok + total_err + total_skp) / max(elapsed, 0.001)
        eta = (n - (i + len(batch))) / max(rate, 0.001)
        log.info("running totals: ok=%d err=%d skp=%d · %.1f files/s · ETA %.0fs",
                  total_ok, total_err, total_skp, rate, eta)

    elapsed = time.time() - t_start
    print(f"done. indexed={total_ok} skipped={total_skp} errors={total_err} elapsed={elapsed:.1f}s")
    return 0 if total_err == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
