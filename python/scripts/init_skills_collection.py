"""Create or verify the `<collection>_skills` Qdrant collection.

Mirrors `init_symbol_collection.py` but with a payload schema tuned for
Claude Code SKILL.md / agents/*.md corpora: skill_name, scope, repo, path,
file_kind are KEYWORD-filterable; description, trigger, content are
full-text searchable. Idempotent — safe to re-run.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from qdrant_client import QdrantClient
from qdrant_client.http.models import (
    Distance,
    HnswConfigDiff,
    PayloadSchemaType,
    TextIndexParams,
    TokenizerType,
    VectorParams,
)

from indexer.config import EMBED_DIM, QDRANT_URL, SKILLS_COLLECTION

KEYWORD_FIELDS = (
    "skill_name",
    "scope",          # "project" | "global"
    "repo",
    "path",
    "file_kind",      # "skill" | "agent" | "reference"
    "trigger",
)

TEXT_FIELDS = ("content", "description", "heading")


def ensure_skills_collection(collection_name: str = SKILLS_COLLECTION) -> None:
    client = QdrantClient(url=QDRANT_URL)
    existing = [c.name for c in client.get_collections().collections]
    if collection_name in existing:
        info = client.get_collection(collection_name)
        current_dim = info.config.params.vectors.size
        if current_dim != EMBED_DIM:
            raise RuntimeError(
                f"skills collection {collection_name!r} has dim={current_dim}, "
                f"config embed_dim={EMBED_DIM}. Refusing to recreate automatically."
            )
        print(f"collection {collection_name!r} exists (points={info.points_count}, dim={current_dim})")
    else:
        client.create_collection(
            collection_name=collection_name,
            vectors_config=VectorParams(
                size=EMBED_DIM,
                distance=Distance.COSINE,
                hnsw_config=HnswConfigDiff(m=16, ef_construct=128, full_scan_threshold=10000),
                on_disk=True,
            ),
            on_disk_payload=True,
        )
        print(f"created collection {collection_name!r} dim={EMBED_DIM}")

    for field in KEYWORD_FIELDS:
        try:
            client.create_payload_index(
                collection_name=collection_name,
                field_name=field,
                field_schema=PayloadSchemaType.KEYWORD,
            )
            print(f"  index {field} KEYWORD")
        except Exception as e:  # noqa: BLE001
            if "already exists" in str(e).lower():
                print(f"  index {field} KEYWORD (exists)")
            else:
                print(f"  index {field} FAILED: {e}")

    for field in TEXT_FIELDS:
        try:
            client.create_payload_index(
                collection_name=collection_name,
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
        except Exception as e:  # noqa: BLE001
            if "already exists" in str(e).lower():
                print(f"  index {field} TEXT (exists)")
            else:
                print(f"  index {field} FAILED: {e}")


def main() -> int:
    ensure_skills_collection()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
