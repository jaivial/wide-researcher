from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
import uuid
from typing import Any

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from qdrant_client.http.models import FieldCondition, Filter, MatchValue, PointStruct

from indexer.chunker import chunk_file
from indexer.config import PROJECT_NAME, PROJECT_ROOT, QDRANT_COLLECTION
from indexer.db import compute_file_hash, extract_symbol_payloads, get_client
from indexer.embed import embed_batch, teardown_provider
from indexer.symbol_types import SYMBOL_INDEX_VERSION
from indexer.walk import iter_files
from scripts.init_symbol_collection import SYMBOL_COLLECTION, ensure_symbol_collection
from scripts.init_symbol_indexes import ensure_symbol_payload_indexes

log = logging.getLogger("symbol-index")
SYMBOL_INDEX_PATH = os.path.join(PROJECT_ROOT, ".wide-researcher", ".symbol_index.json")
SUPPORTED_LANGUAGES = {"typescript", "tsx", "csharp"}


def _load_symbol_index() -> dict[str, dict[str, Any]]:
    if not os.path.isfile(SYMBOL_INDEX_PATH):
        return {}
    try:
        with open(SYMBOL_INDEX_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        log.warning("symbol index sidecar load failed (%s) — starting fresh", e)
        return {}


def _save_symbol_index(data: dict[str, dict[str, Any]]) -> None:
    os.makedirs(os.path.dirname(SYMBOL_INDEX_PATH), exist_ok=True)
    tmp = SYMBOL_INDEX_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, SYMBOL_INDEX_PATH)


def _read_source(abs_path: str) -> tuple[bytes, str] | None:
    try:
        with open(abs_path, "rb") as f:
            raw = f.read()
    except OSError as e:
        log.warning("read failed %s: %s", abs_path, e)
        return None
    try:
        return raw, raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw, raw.decode("utf-8", errors="replace")


def _chunk_records(abs_path: str) -> dict[int, tuple[Any, str | int]]:
    client = get_client()
    points: dict[int, tuple[Any, str | int]] = {}
    offset = None
    while True:
        rows, offset = client.scroll(
            collection_name=QDRANT_COLLECTION,
            scroll_filter=Filter(must=[FieldCondition(key="file_path", match=MatchValue(value=abs_path))]),
            limit=256,
            offset=offset,
            with_payload=["chunk_index"],
            with_vectors=False,
        )
        for row in rows:
            payload = row.payload or {}
            chunk_index = payload.get("chunk_index")
            if isinstance(chunk_index, int):
                points[chunk_index] = (row.id, row.id)
        if offset is None:
            break
    return points


def _update_chunk_payloads(abs_path: str, payloads: dict[int, dict[str, Any]]) -> int:
    chunk_points = _chunk_records(abs_path)
    if not chunk_points:
        return 0
    client = get_client()
    updated = 0
    for chunk_index, payload in payloads.items():
        point = chunk_points.get(chunk_index)
        if point is None:
            continue
        point_id, _ = point
        client.set_payload(
            collection_name=QDRANT_COLLECTION,
            payload=payload,
            points=[point_id],
            wait=False,
        )
        updated += 1
    return updated


def _delete_symbol_nodes_for_file(abs_path: str) -> None:
    client = get_client()
    client.delete(
        collection_name=SYMBOL_COLLECTION,
        points_selector=Filter(must=[FieldCondition(key="file_path", match=MatchValue(value=abs_path))]),
        wait=True,
    )


def _symbol_point_id(node_id: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"wr-symbol::{QDRANT_COLLECTION}::{node_id}"))


def _upsert_symbol_nodes(graph) -> int:
    payloads = graph.node_payloads()
    if not payloads:
        _delete_symbol_nodes_for_file(graph.file_path)
        return 0
    _delete_symbol_nodes_for_file(graph.file_path)
    texts = [str(p.get("graph_text") or p.get("signature") or p.get("name") or "") for p in payloads]
    vectors = embed_batch(texts)
    points = [
        PointStruct(
            id=_symbol_point_id(str(payload["node_id"])),
            vector=list(vector),
            payload=payload,
        )
        for payload, vector in zip(payloads, vectors)
    ]
    client = get_client()
    for i in range(0, len(points), 64):
        client.upsert(collection_name=SYMBOL_COLLECTION, points=points[i : i + 64], wait=False)
    return len(points)


def _process_file(abs_path: str, repo: str, language: str, with_node_embeddings: bool) -> tuple[str, int, int, str]:
    source = _read_source(abs_path)
    if source is None:
        return "error", 0, 0, ""
    raw, text = source
    file_hash = compute_file_hash(raw)
    chunks = chunk_file(abs_path, language, text)
    graph, payloads = extract_symbol_payloads(repo, abs_path, file_hash, language, text, chunks)
    updated_chunks = _update_chunk_payloads(abs_path, payloads)
    updated_nodes = _upsert_symbol_nodes(graph) if with_node_embeddings else 0
    return "indexed", updated_chunks, updated_nodes, file_hash


def _delete_stale_symbol_nodes(files: set[str], sidecar: dict[str, dict[str, Any]], with_node_embeddings: bool) -> int:
    stale = [path for path in sidecar if path not in files]
    if not stale:
        return 0
    for path in stale:
        if with_node_embeddings:
            _delete_symbol_nodes_for_file(path)
        sidecar.pop(path, None)
    return len(stale)


def main() -> int:
    parser = argparse.ArgumentParser(prog="symbol-index")
    parser.add_argument("--force", action="store_true", help="Recompute symbol payloads for all supported files")
    parser.add_argument("--max-files", type=int, default=0, help="Process at most N changed files")
    nodes = parser.add_mutually_exclusive_group()
    nodes.add_argument("--with-node-embeddings", action="store_true", help="Create/update the symbol-node Qdrant collection")
    nodes.add_argument("--no-node-embeddings", action="store_true", help="Only update payloads on existing code chunks")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING, format="%(asctime)s %(levelname)s %(message)s")
    with_node_embeddings = bool(args.with_node_embeddings)

    ensure_symbol_payload_indexes()
    if with_node_embeddings:
        ensure_symbol_collection()

    files = [(repo, abs_path, language) for repo, abs_path, language in iter_files([PROJECT_ROOT]) if language in SUPPORTED_LANGUAGES]
    current_files = {abs_path for _, abs_path, _ in files}
    sidecar = _load_symbol_index()
    stale = _delete_stale_symbol_nodes(current_files, sidecar, with_node_embeddings)

    to_process: list[tuple[str, str, str, str]] = []
    for repo, abs_path, language in files:
        source = _read_source(abs_path)
        if source is None:
            continue
        raw, _ = source
        file_hash = compute_file_hash(raw)
        meta = sidecar.get(abs_path, {})
        has_current_payload = meta.get("file_hash") == file_hash and meta.get("symbol_index_version") == SYMBOL_INDEX_VERSION
        has_nodes = not with_node_embeddings or meta.get("node_embeddings") is True
        if args.force or not (has_current_payload and has_nodes):
            to_process.append((repo, abs_path, language, file_hash))

    if args.max_files:
        to_process = to_process[: args.max_files]

    indexed = skipped = errors = chunks = nodes_count = 0
    start = time.time()
    for repo, abs_path, language, expected_hash in to_process:
        status, updated_chunks, updated_nodes, file_hash = _process_file(abs_path, repo, language, with_node_embeddings)
        if status == "indexed":
            indexed += 1
            chunks += updated_chunks
            nodes_count += updated_nodes
            previous_node_embeddings = bool(sidecar.get(abs_path, {}).get("node_embeddings"))
            sidecar[abs_path] = {
                "repo": repo,
                "file_hash": file_hash or expected_hash,
                "language": language,
                "symbol_index_version": SYMBOL_INDEX_VERSION,
                "node_embeddings": with_node_embeddings or previous_node_embeddings,
                "updated_chunks": updated_chunks,
                "updated_nodes": updated_nodes,
            }
        else:
            errors += 1
        if indexed and indexed % 100 == 0:
            _save_symbol_index(sidecar)
            teardown_provider()

    skipped = max(0, len(files) - len(to_process))
    _save_symbol_index(sidecar)
    teardown_provider()
    elapsed = time.time() - start
    print(
        f"done. indexed={indexed} skipped={skipped} errors={errors} stale={stale} "
        f"updated_chunks={chunks} symbol_nodes={nodes_count} elapsed={elapsed:.1f}s"
    )
    return 0 if errors == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
