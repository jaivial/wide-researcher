"""Create or recreate the project's Qdrant collection.

Idempotent — safe to re-run. Reads project context from the JSON file
pointed at by `WIDE_RESEARCHER_PROJECT_CONFIG`.
"""
from __future__ import annotations

import sys

# `indexer.config` reads the env var and exports the resolved values
sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.dirname(__import__("os").path.abspath(__file__))))
from indexer.config import QDRANT_URL, QDRANT_COLLECTION, EMBED_DIM  # noqa: E402

from qdrant_client import QdrantClient  # noqa: E402
from qdrant_client.http.models import (  # noqa: E402
    Distance,
    VectorParams,
    HnswConfigDiff,
    PayloadSchemaType,
    TextIndexParams,
    TokenizerType,
)

client = QdrantClient(url=QDRANT_URL)


def ensure_collection():
    existing = [c.name for c in client.get_collections().collections]
    if QDRANT_COLLECTION in existing:
        info = client.get_collection(QDRANT_COLLECTION)
        print(
            f"collection {QDRANT_COLLECTION!r} exists "
            f"(points={info.points_count}, dim={info.config.params.vectors.size})"
        )
        if info.config.params.vectors.size != EMBED_DIM:
            print(
                f"  WARNING: existing dim={info.config.params.vectors.size} "
                f"!= EMBED_DIM={EMBED_DIM}. Recreating."
            )
            client.delete_collection(QDRANT_COLLECTION)
            existing.remove(QDRANT_COLLECTION)
    if QDRANT_COLLECTION not in existing:
        client.create_collection(
            collection_name=QDRANT_COLLECTION,
            vectors_config=VectorParams(
                size=EMBED_DIM,
                distance=Distance.COSINE,
                hnsw_config=HnswConfigDiff(m=16, ef_construct=128, full_scan_threshold=10000),
                on_disk=True,
            ),
            on_disk_payload=True,
        )
        print(f"created collection {QDRANT_COLLECTION!r} dim={EMBED_DIM}")


def ensure_indexes():
    for field in (
        "repo", "language", "role", "atomic_layer",
        "file_path", "symbol_kind", "file_hash",
    ):
        try:
            client.create_payload_index(
                collection_name=QDRANT_COLLECTION,
                field_name=field,
                field_schema=PayloadSchemaType.KEYWORD,
            )
            print(f"  index {field} KEYWORD")
        except Exception as e:
            if "already exists" in str(e).lower():
                print(f"  index {field} KEYWORD (exists)")
            else:
                print(f"  index {field} FAILED: {e}")

    for field in ("content", "symbol_name"):
        try:
            client.create_payload_index(
                collection_name=QDRANT_COLLECTION,
                field_name=field,
                field_schema=TextIndexParams(
                    type="text",
                    tokenizer=TokenizerType.WORD,
                    lowercase=True,
                    min_token_len=2,
                    max_token_len=30,
                ),
            )
            print(f"  index {field} TEXT")
        except Exception as e:
            if "already exists" in str(e).lower():
                print(f"  index {field} TEXT (exists)")
            else:
                print(f"  index {field} FAILED: {e}")


if __name__ == "__main__":
    ensure_collection()
    ensure_indexes()
    info = client.get_collection(QDRANT_COLLECTION)
    print(f"\nfinal: points={info.points_count}, status={info.status}")
