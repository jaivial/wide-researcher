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
from .embed import embed_batch, embed_query, get_model, teardown_provider
from .config import CHUNK_CAP, MAX_RSS_MB
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


# Maximum chunks to embed in a single API call. Keeps Cohere/httpx
# memory bounded even for files with hundreds of chunks.
_EMBED_MICRO_BATCH = 32


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

    # Free file content early for large files
    del raw

    t0 = time.time()
    chunks = chunk_file(abs_path, language, text)
    del text  # free source text

    if not chunks:
        try:
            upsert_file(None, repo, abs_path, file_hash, [], [], [], language)
        except Exception as e:  # noqa: BLE001
            log.warning("upsert empty failed %s: %s", abs_path, e)
            return ("error", 0)
        return ("indexed", 0)

    # Chunk cap — prevent OOM on files that produce thousands of chunks
    if len(chunks) > CHUNK_CAP:
        log.warning(
            "truncating %s from %d to %d chunks (chunk_cap=%d)",
            abs_path, len(chunks), CHUNK_CAP, CHUNK_CAP,
        )
        chunks = chunks[:CHUNK_CAP]

    # Build embed-input texts (with optional path boost)
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

    # ── Memory-safe micro-batch embedding ──────────────────────────────
    # For files with many chunks (large files), embed in micro-batches
    # so we never hold all embeddings + all chunks in RAM simultaneously.
    # After each micro-batch we stream the upsert to Qdrant and free the
    # intermediate vectors.
    total_chunks = len(chunks)
    all_ok = True
    meta_base = derive_metadata(abs_path, repo, language)

    # Pre-delete old points for this file once
    from .db import get_client, QDRANT_COLLECTION
    from qdrant_client.http.models import Filter, FieldCondition, MatchValue
    client = get_client()
    client.delete(
        collection_name=QDRANT_COLLECTION,
        points_selector=Filter(
            must=[FieldCondition(key="file_path", match=MatchValue(value=abs_path))]
        ),
    )

    for start in range(0, total_chunks, _EMBED_MICRO_BATCH):
        end = min(start + _EMBED_MICRO_BATCH, total_chunks)
        batch_texts = texts[start:end]
        batch_chunks = chunks[start:end]
        batch_metas = [meta_base for _ in batch_chunks]

        try:
            batch_embeds = embed_batch(batch_texts)
        except Exception as e:  # noqa: BLE001
            log.warning("embed failed %s (batch %d-%d): %s", abs_path, start, end, e)
            all_ok = False
            break

        # Stream upsert this micro-batch directly to Qdrant
        from qdrant_client.http.models import PointStruct
        from .db import _point_id
        points = []
        for ch, vec, meta in zip(batch_chunks, batch_embeds, batch_metas):
            payload = {
                "repo": repo,
                "file_path": abs_path,
                "file_hash": file_hash,
                "chunk_index": ch.chunk_index,
                "start_line": ch.start_line,
                "end_line": ch.end_line,
                "language": language,
                "symbol_kind": ch.symbol_kind,
                "symbol_name": ch.symbol_name,
                "content": ch.content,
                "content_tokens": ch.content_tokens,
            }
            for k in ("role", "atomic_layer", "is_test", "is_story", "route_owner"):
                if k in meta:
                    payload[k] = meta[k]
            points.append(
                PointStruct(
                    id=_point_id(abs_path, ch.chunk_index),
                    vector=list(vec),
                    payload=payload,
                )
            )
        for i in range(0, len(points), 64):
            client.upsert(
                collection_name=QDRANT_COLLECTION,
                points=points[i : i + 64],
                wait=False,
            )

        # Free this micro-batch's memory before the next one
        del batch_texts, batch_embeds, batch_chunks, batch_metas, points
        gc.collect()

    del texts
    gc.collect()

    # Update file index sidecar
    from .db import _load_file_index, _save_file_index
    fidx = _load_file_index()
    fidx[abs_path] = {
        "repo": repo,
        "file_hash": file_hash,
        "chunk_count": total_chunks,
        "language": language,
    }
    _save_file_index(fidx)

    if not all_ok:
        return ("error", 0)

    if verbose:
        log.info("indexed %s (%d chunks) in %.2fs", abs_path, total_chunks, time.time() - t0)
    return ("indexed", total_chunks)


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
        if i and i % 200 == 0:
            # Hard memory-pressure relief every 200 files.
            # teardown_provider() closes the Cohere httpx pool (if Cohere)
            # and releases the local model (if local), then GC reclaims.
            teardown_provider()
            gc.collect()
            # Log RSS so OOM regressions are visible.
            try:
                import resource
                rss_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024
                log.info("memory cycle at file %d — RSS peak %d MB (limit %d MB)", i, rss_mb, MAX_RSS_MB)
            except Exception:  # noqa: BLE001
                pass

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
