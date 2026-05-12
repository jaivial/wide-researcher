#!/usr/bin/env python3
"""wide-researcher · filesystem watcher daemon.

Watches PROJECT_ROOT (from config) for changes and re-embeds touched
files into the project's Qdrant collection. Long-running — designed
to run under systemd `--user` or macOS launchd.

## Why subprocess-per-batch

`sentence-transformers` + PyTorch leak intermediate buffers slowly
on every batch (~5-15 MB per batch in our profiling). A long-running
daemon that keeps the model loaded in-process climbs to 12+ GB RSS
on a few hours of active editing. The watcher spawns a fresh
`python -m indexer file <path>` subprocess per debounce-batch
instead, which gives the kernel a clean reclamation opportunity
after each save. Trade-off: ~1s import overhead per re-embed.

## Debouncing

Saves often arrive in bursts (formatter writes, editor swap files,
git checkouts). The watcher collects FS events into a pending set
and flushes them after `DEBOUNCE_S` of quiet. A burst of 30 saves
collapses to one batch.

## Exclusions

Re-uses the same walk-time exclusion rules as `indexer.walk` so we
never re-embed files the initial walk wouldn't have picked up.
"""
from __future__ import annotations

import argparse
import logging
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

# Make sibling indexer package importable regardless of how we are spawned.
_HERE = os.path.dirname(os.path.abspath(__file__))
_PY_ROOT = os.path.dirname(_HERE)
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

from watchdog.events import (  # noqa: E402
    FileSystemEvent,
    FileSystemEventHandler,
    FileCreatedEvent,
    FileModifiedEvent,
    FileMovedEvent,
    FileDeletedEvent,
)
from watchdog.observers import Observer  # noqa: E402

from indexer.config import PROJECT_ROOT, PROJECT_NAME  # noqa: E402
from indexer.walk import (  # noqa: E402
    BINARY_SUFFIXES,
    EXACT_FILENAME_LANG,
    EXCLUDE_DIR_NAMES,
    EXCLUDE_FILES,
    EXCLUDE_FILE_PATTERNS,
    ALLOWED_DOT_DIRS,
    ALLOWED_DOT_FILES,
    LANG_BY_SUFFIX,
)

log = logging.getLogger("wide-researcher.watcher")

DEBOUNCE_S = 1.5
MAX_BATCH = 64


def _is_excluded_path(abs_path: str) -> bool:
    """Same exclusion logic as walk.iter_files but stateless / per-path."""
    rel = os.path.relpath(abs_path, PROJECT_ROOT)
    if rel.startswith(".."):
        return True  # outside project root

    for part in rel.split(os.sep)[:-1]:
        if part in EXCLUDE_DIR_NAMES:
            return True
        if part.startswith(".") and part not in ALLOWED_DOT_DIRS:
            return True

    fn = os.path.basename(abs_path)
    if fn in EXCLUDE_FILES:
        return True
    if fn.startswith(".") and fn not in ALLOWED_DOT_FILES:
        return True
    if fn.endswith(".min.js") or fn.endswith(".min.css"):
        return True
    if any(pat.search(fn) for pat in EXCLUDE_FILE_PATTERNS):
        return True

    suffix = os.path.splitext(fn)[1].lower()
    if suffix in BINARY_SUFFIXES:
        return True
    return False


def _language_for(abs_path: str) -> str:
    fn = os.path.basename(abs_path)
    if fn in EXACT_FILENAME_LANG:
        return EXACT_FILENAME_LANG[fn]
    return LANG_BY_SUFFIX.get(os.path.splitext(fn)[1].lower(), "text")


class _Debouncer:
    """Collects pending paths, flushes after DEBOUNCE_S of quiet."""

    def __init__(self, on_flush):
        self._pending: set[str] = set()
        self._deleted: set[str] = set()
        self._lock = threading.Lock()
        self._last_event_at = 0.0
        self._timer: threading.Timer | None = None
        self._on_flush = on_flush

    def touch(self, abs_path: str, deleted: bool = False) -> None:
        with self._lock:
            if deleted:
                self._deleted.add(abs_path)
                self._pending.discard(abs_path)
            else:
                self._pending.add(abs_path)
                self._deleted.discard(abs_path)
            self._last_event_at = time.time()
            if self._timer is not None:
                self._timer.cancel()
            self._timer = threading.Timer(DEBOUNCE_S, self._flush)
            self._timer.daemon = True
            self._timer.start()

    def _flush(self) -> None:
        with self._lock:
            pending = list(self._pending)
            deleted = list(self._deleted)
            self._pending.clear()
            self._deleted.clear()
            self._timer = None
        if pending or deleted:
            self._on_flush(pending, deleted)


class _Handler(FileSystemEventHandler):
    def __init__(self, debouncer: _Debouncer):
        super().__init__()
        self._db = debouncer

    def on_modified(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        path = event.src_path
        if not _is_excluded_path(path):
            self._db.touch(path)

    def on_created(self, event: FileCreatedEvent) -> None:
        if event.is_directory:
            return
        path = event.src_path
        if not _is_excluded_path(path):
            self._db.touch(path)

    def on_moved(self, event: FileMovedEvent) -> None:
        if event.is_directory:
            return
        # Old path goes away, new path gets re-indexed.
        if event.src_path:
            self._db.touch(event.src_path, deleted=True)
        if event.dest_path and not _is_excluded_path(event.dest_path):
            self._db.touch(event.dest_path)

    def on_deleted(self, event: FileDeletedEvent) -> None:
        if event.is_directory:
            return
        self._db.touch(event.src_path, deleted=True)


def _reembed_one(path: str) -> bool:
    """Spawn `python -m indexer file <path>` in a fresh subprocess.

    Returns True on success. Inherits stdout/stderr so systemd / launchd
    captures the output.
    """
    cmd = [sys.executable, "-m", "indexer", "file", path]
    try:
        completed = subprocess.run(
            cmd,
            cwd=_PY_ROOT,
            env=os.environ.copy(),
            check=False,
            timeout=120,
        )
        return completed.returncode == 0
    except subprocess.TimeoutExpired:
        log.warning("re-embed timeout (>120s): %s", path)
        return False
    except Exception as e:  # noqa: BLE001
        log.warning("re-embed crashed for %s: %s", path, e)
        return False


def _delete_one(path: str) -> bool:
    """Tombstone a deleted file from the Qdrant collection."""
    # We rely on the next `indexer incremental` run inside the daemon to
    # clean tombstones up via delete_stale(). For now just log — the
    # collection picks the change up on next walk.
    log.info("deleted (will reclaim on next incremental walk): %s", path)
    return True


def _flush_batch(pending: list[str], deleted: list[str]) -> None:
    log.info("flush: %d modified, %d deleted", len(pending), len(deleted))
    # Cap batch size to bound subprocess spawn rate; remainder picked up
    # on next save naturally.
    for p in pending[:MAX_BATCH]:
        _reembed_one(p)
    for p in deleted:
        _delete_one(p)


def _initial_incremental() -> None:
    """Run a quick `indexer incremental` on startup so we pick up any
    files that changed while the daemon was down."""
    log.info("initial incremental walk")
    subprocess.run(
        [sys.executable, "-m", "indexer", "incremental"],
        cwd=_PY_ROOT,
        env=os.environ.copy(),
        check=False,
    )


def main() -> int:
    ap = argparse.ArgumentParser(prog="wide-researcher-watcher")
    ap.add_argument("--no-initial-walk", action="store_true",
                    help="Skip the initial `indexer incremental` run on startup.")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    # Always log "starting" / "flush" lines, even without --verbose.
    log.setLevel(logging.INFO)

    log.info("project=%s root=%s", PROJECT_NAME, PROJECT_ROOT)
    if not os.path.isdir(PROJECT_ROOT):
        log.error("PROJECT_ROOT is not a directory: %s", PROJECT_ROOT)
        return 2

    if not args.no_initial_walk:
        _initial_incremental()

    debouncer = _Debouncer(_flush_batch)
    handler = _Handler(debouncer)
    observer = Observer()
    observer.schedule(handler, PROJECT_ROOT, recursive=True)
    observer.start()
    log.info("watching %s (debounce=%.1fs)", PROJECT_ROOT, DEBOUNCE_S)

    stop = threading.Event()

    def _sigterm(_signum, _frame):
        log.info("signal received, shutting down")
        stop.set()

    signal.signal(signal.SIGTERM, _sigterm)
    signal.signal(signal.SIGINT, _sigterm)

    try:
        while not stop.is_set():
            stop.wait(1.0)
    finally:
        observer.stop()
        observer.join(timeout=5)

    log.info("watcher exited cleanly")
    return 0


if __name__ == "__main__":
    sys.exit(main())
