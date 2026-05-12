"""CLI entry: python -m indexer <cmd>.

Project context comes from the JSON file pointed at by the
`WIDE_RESEARCHER_PROJECT_CONFIG` environment variable. The CLI never
takes per-project paths as flags — it always reads them from config.
"""
from __future__ import annotations

import argparse
import gc
import logging
import os
import sys
import time
from collections import Counter

from tqdm import tqdm

from .config import PROJECT_ROOT, PROJECT_NAME, QDRANT_COLLECTION
from .walk import iter_files
from .chunker import chunk_file
from .metadata import derive_metadata
from .embed import embed_batch, embed_query, get_model
from .db import (
    compute_file_hash,
    get_indexed_files,
    upsert_file,
    delete_stale,
    get_client,
)

log = logging.getLogger("indexer")


def _read_bytes(path: str) -> bytes | None:
    try:
        with open(path, "rb") as f:
            return f.read()
    except OSError as e:
        log.warning("read failed %s: %s", path, e)
        return None


def _process_file(
    _conn,
    abs_path: str,
    repo: str,
    language: str,
    indexed_hashes: dict[str, str] | None,
    force: bool,
    verbose: bool,
) -> tuple[str, int]:
    raw = _read_bytes(abs_path)
    if raw is None:
        return ("error", 0)
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("utf-8", errors="replace")

    file_hash = compute_file_hash(raw)
    if not force and indexed_hashes is not None and indexed_hashes.get(abs_path) == file_hash:
        return ("skipped", 0)

    t0 = time.time()
    chunks = chunk_file(abs_path, language, text)
    if not chunks:
        try:
            upsert_file(None, repo, abs_path, file_hash, [], [], [], language)
        except Exception as e:  # noqa: BLE001
            log.warning("upsert empty failed %s: %s", abs_path, e)
            return ("error", 0)
        return ("indexed", 0)

    # Boost the EMBED INPUT (not the stored content) with filename + parent
    # folder signal so retrieval picks up on path-level identity. Skip for
    # JSON locales and markdown so we don't over-bias their key headings.
    if language in ("typescript", "tsx", "csharp", "python", "go", "rust"):
        basename = os.path.basename(abs_path)
        parts = abs_path.split(os.sep)
        parent_folders = " ".join(parts[-3:-1]) if len(parts) >= 3 else ""
        name_prefix = (
            f"// {basename} ({parent_folders})\n" if parent_folders else f"// {basename}\n"
        )
        texts = [name_prefix + c.content for c in chunks]
    else:
        texts = [c.content for c in chunks]

    try:
        embeds = embed_batch(texts)
    except Exception as e:  # noqa: BLE001
        log.warning("embed failed %s: %s", abs_path, e)
        return ("error", 0)

    meta_base = derive_metadata(abs_path, repo, language)
    metas = [meta_base for _ in chunks]

    try:
        upsert_file(None, repo, abs_path, file_hash, chunks, embeds, metas, language)
    except Exception as e:  # noqa: BLE001
        log.warning("upsert failed %s: %s", abs_path, e)
        return ("error", 0)

    if verbose:
        log.info("indexed %s (%d chunks) in %.2fs", abs_path, len(chunks), time.time() - t0)
    return ("indexed", len(chunks))


def cmd_reindex(args):
    return _run_index(force=args.force, verbose=args.verbose, single_file=None)


def cmd_incremental(args):
    return _run_index(force=False, verbose=args.verbose, single_file=None)


def cmd_file(args):
    return _run_index(force=True, verbose=True, single_file=args.path)


def _run_index(force: bool, verbose: bool, single_file: str | None):
    logging.basicConfig(level=logging.INFO if verbose else logging.WARNING,
                        format="%(asctime)s %(levelname)s %(message)s")
    get_model()

    if single_file:
        abs_path = os.path.abspath(single_file)
        if not abs_path.startswith(PROJECT_ROOT + os.sep) and abs_path != PROJECT_ROOT:
            log.error("file is outside PROJECT_ROOT (%s): %s", PROJECT_ROOT, abs_path)
            return 2
        ext = os.path.splitext(abs_path)[1].lower()
        from .walk import LANG_BY_SUFFIX, EXACT_FILENAME_LANG
        basename = os.path.basename(abs_path)
        language = EXACT_FILENAME_LANG.get(basename) or LANG_BY_SUFFIX.get(ext, "text")
        status, n = _process_file(None, abs_path, PROJECT_NAME, language, None, True, True)
        print(f"{status}: {abs_path} ({n} chunks)")
        return 0

    log.info("walking root: %s", PROJECT_ROOT)
    files = list(iter_files([PROJECT_ROOT]))
    log.info("discovered %d candidate files", len(files))

    indexed = get_indexed_files()
    current = {p for _, p, _ in files}
    removed = delete_stale(None, current)
    if removed:
        print(f"removed {removed} stale files")

    t_start = time.time()
    n_indexed = 0
    n_skipped = 0
    n_error = 0
    total_chunks = 0
    iterator = tqdm(files, desc="indexing", unit="file") if not verbose else files
    for i, (repo, abs_path, language) in enumerate(iterator):
        status, n = _process_file(None, abs_path, repo, language, indexed, force, verbose)
        if status == "indexed":
            n_indexed += 1
            total_chunks += n
        elif status == "skipped":
            n_skipped += 1
        else:
            n_error += 1
        gc.collect()
        if i and i % 500 == 0:
            # Cycle the embedder every 500 files to release accumulated
            # PyTorch buffers — keeps RSS bounded on huge codebases.
            import indexer.embed as _em  # type: ignore[import-not-found]
            _em._model = None
            gc.collect()

    elapsed = time.time() - t_start
    print(
        f"done. indexed={n_indexed} skipped={n_skipped} errors={n_error} "
        f"new_chunks={total_chunks} elapsed={elapsed:.1f}s "
        f"({n_indexed/max(elapsed, 0.001):.1f} files/s, "
        f"{total_chunks/max(elapsed, 0.001):.1f} chunks/s)"
    )
    return 0


def cmd_status(_args):
    from .db import _load_file_index
    fidx = _load_file_index()
    client = get_client()
    info = client.get_collection(QDRANT_COLLECTION)
    print(
        f"project={PROJECT_NAME} root={PROJECT_ROOT}\n"
        f"collection={QDRANT_COLLECTION} files={len(fidx)} "
        f"chunks={info.points_count} status={info.status}"
    )
    by_lang = Counter(v["language"] for v in fidx.values())
    print("\nfiles by language:")
    for l, n in by_lang.most_common():
        print(f"  {l:>12}  {n}")
    return 0


def cmd_search_debug(args):
    from qdrant_client.http.models import SearchParams
    vec = embed_query(args.query)
    client = get_client()
    res = client.query_points(
        collection_name=QDRANT_COLLECTION,
        query=vec,
        limit=5,
        with_payload=True,
        search_params=SearchParams(hnsw_ef=128),
    )
    print(f"query: {args.query!r}")
    for i, h in enumerate(res.points, 1):
        p = h.payload or {}
        print(
            f"{i}. score={h.score:.4f}  {p.get('file_path', '?')}:"
            f"{p.get('start_line', '?')}-{p.get('end_line', '?')}  "
            f"[{p.get('symbol_kind') or '-'}] {p.get('symbol_name') or ''}"
        )
    return 0


def main():
    parser = argparse.ArgumentParser(prog="wide-researcher-indexer",
                                       description="wide-researcher qdrant indexer")
    parser.add_argument("--verbose", action="store_true")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_re = sub.add_parser("reindex", help="walk + chunk + embed + upsert everything")
    p_re.add_argument("--force", action="store_true")
    p_re.set_defaults(func=cmd_reindex)

    p_inc = sub.add_parser("incremental", help="re-index only files whose hash changed")
    p_inc.set_defaults(func=cmd_incremental)

    p_f = sub.add_parser("file", help="index a single file path")
    p_f.add_argument("path")
    p_f.set_defaults(func=cmd_file)

    p_s = sub.add_parser("status", help="print summary")
    p_s.set_defaults(func=cmd_status)

    p_sd = sub.add_parser("search-debug", help="semantic search sanity check")
    p_sd.add_argument("query")
    p_sd.set_defaults(func=cmd_search_debug)

    args = parser.parse_args()
    if not getattr(args, "verbose", False):
        logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(levelname)s %(message)s")
    rc = args.func(args)
    sys.exit(rc or 0)
