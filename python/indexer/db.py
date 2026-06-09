"""Qdrant-backed indexer storage.

One collection per project (named in config.json), holds every chunk
for that project. A small JSON sidecar (`.file_index.json`) tracks
file→hash mapping for the incremental hash-skip optimisation so the
indexer never has to scroll the entire collection on every reindex.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import uuid
from typing import Any, Sequence

from qdrant_client import QdrantClient
from qdrant_client.http.models import (
    Filter,
    FieldCondition,
    MatchValue,
    PointStruct,
)

from .config import (
    QDRANT_URL,
    QDRANT_COLLECTION,
    SKILLS_COLLECTION,
    FILE_INDEX_PATH,
)
from .symbol_extractor import extract_file_graph
from .symbol_types import FileGraphRecord

log = logging.getLogger(__name__)

_client: QdrantClient | None = None


def get_client() -> QdrantClient:
    global _client
    if _client is None:
        _client = QdrantClient(url=QDRANT_URL)
    return _client


# ── File hash tracking (sidecar JSON, project-local) ──────────────────────────


def compute_file_hash(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _load_file_index() -> dict[str, dict]:
    if not os.path.isfile(FILE_INDEX_PATH):
        return {}
    try:
        with open(FILE_INDEX_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        log.warning("file_index load failed (%s) — starting fresh", e)
        return {}


def _save_file_index(data: dict[str, dict]) -> None:
    os.makedirs(os.path.dirname(FILE_INDEX_PATH) or ".", exist_ok=True)
    tmp = FILE_INDEX_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, FILE_INDEX_PATH)


def get_indexed_files(_conn=None) -> dict[str, str]:
    """Return {file_path: file_hash} for every file in the index."""
    return {p: meta["file_hash"] for p, meta in _load_file_index().items()}


# ── Qdrant point IDs ─────────────────────────────────────────────────────────

def _point_id(file_path: str, chunk_index: int) -> str:
    """Deterministic UUID v5 — idempotent (same input → same id)."""
    return str(
        uuid.uuid5(uuid.NAMESPACE_URL, f"wr::{QDRANT_COLLECTION}::{file_path}::{chunk_index}")
    )


# ── Payload helpers ──────────────────────────────────────────────────────────


def extract_symbol_payloads(
    repo: str,
    file_path: str,
    file_hash: str,
    language: str,
    source: str,
    chunks: Sequence,
) -> tuple[FileGraphRecord, dict[int, dict[str, Any]]]:
    graph = extract_file_graph(repo, file_path, file_hash, language, source)
    if language not in ("typescript", "tsx", "csharp"):
        return graph, {}
    payloads = {
        ch.chunk_index: graph.payload_for_range(ch.start_line, ch.end_line)
        for ch in chunks
    }
    return graph, payloads


def build_chunk_payload(
    repo: str,
    file_path: str,
    file_hash: str,
    language: str,
    ch,
    meta: dict[str, Any],
    symbol_payloads: dict[int, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    payload = {
        "repo": repo,
        "file_path": file_path,
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
    for k in ("role", "runtime", "atomic_layer", "is_test", "is_story", "route_owner"):
        if k in meta:
            payload[k] = meta[k]
    if symbol_payloads is not None:
        payload.update(symbol_payloads.get(ch.chunk_index, {}))
    return payload


# ── Upsert + stale-delete ────────────────────────────────────────────────────


def upsert_file(
    _conn,
    repo: str,
    file_path: str,
    file_hash: str,
    chunks: Sequence,
    embeddings: Sequence,
    metadatas: Sequence,
    language: str,
    symbol_payloads: dict[int, dict[str, Any]] | None = None,
) -> int:
    """Replace all points for `file_path` with the new chunk set."""
    client = get_client()
    chunk_count = len(chunks)

    client.delete(
        collection_name=QDRANT_COLLECTION,
        points_selector=Filter(
            must=[FieldCondition(key="file_path", match=MatchValue(value=file_path))]
        ),
    )

    if chunk_count:
        points = []
        for ch, vec, meta in zip(chunks, embeddings, metadatas):
            payload = build_chunk_payload(repo, file_path, file_hash, language, ch, meta, symbol_payloads)
            points.append(
                PointStruct(
                    id=_point_id(file_path, ch.chunk_index),
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

    fidx = _load_file_index()
    fidx[file_path] = {
        "repo": repo,
        "file_hash": file_hash,
        "chunk_count": chunk_count,
        "language": language,
    }
    _save_file_index(fidx)
    return chunk_count


def delete_stale(_conn, current_files: set[str]) -> int:
    """Remove points for files no longer on disk."""
    client = get_client()
    fidx = _load_file_index()
    gone = [p for p in fidx if p not in current_files]
    if not gone:
        return 0
    for path in gone:
        client.delete(
            collection_name=QDRANT_COLLECTION,
            points_selector=Filter(
                must=[FieldCondition(key="file_path", match=MatchValue(value=path))]
            ),
        )
        fidx.pop(path, None)
    _save_file_index(fidx)
    log.info("removed %d stale files", len(gone))
    return len(gone)


# ── Skills collection helpers ───────────────────────────────────────────────


def _skills_point_id(skill_name: str, heading: str, path: str) -> str:
    """Deterministic UUID for one skill-chunk point."""
    return str(
        uuid.uuid5(
            uuid.NAMESPACE_URL,
            f"wr-skills::{QDRANT_COLLECTION}::{skill_name}::{heading}::{path}",
        )
    )


def upsert_skill(
    *,
    skill_name: str,
    scope: str,
    repo: str,
    path: str,
    file_kind: str,
    description: str,
    trigger: str,
    content: str,
    heading: str,
    vector: list[float],
) -> str:
    """Upsert a single skill chunk into the skills collection.

    Returns the point id used.
    """
    client = get_client()
    point_id = _skills_point_id(skill_name, heading, path)
    payload = {
        "skill_name": skill_name,
        "scope": scope,
        "repo": repo,
        "path": path,
        "file_kind": file_kind,
        "description": description,
        "trigger": trigger,
        "heading": heading,
        "content": content,
    }
    client.upsert(
        collection_name=SKILLS_COLLECTION,
        points=[PointStruct(id=point_id, vector=list(vector), payload=payload)],
        wait=True,
    )
    return point_id


def delete_skill_points(path: str) -> int:
    """Remove every skill chunk for a given source path (e.g. before reindex)."""
    client = get_client()
    client.delete(
        collection_name=SKILLS_COLLECTION,
        points_selector=Filter(
            must=[FieldCondition(key="path", match=MatchValue(value=path))]
        ),
    )
    return 1

