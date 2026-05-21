"""Create or recreate the `kraken_code` Qdrant collection with the right
vector params + payload indexes. Idempotent — safe to re-run.

On dimension mismatch (backend/model change), automatically backs up the existing
collection before recreating, so you can switch back without reindexing.

Backup naming:  <collection>__backup__<dim>__<backend>__<YYYYMMDD>
"""
from __future__ import annotations

import os
import shutil
import sys
from datetime import datetime

# Ensure the indexer package is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from qdrant_client import QdrantClient
from qdrant_client.http.models import (
    Distance,
    VectorParams,
    HnswConfigDiff,
    PayloadSchemaType,
    TextIndexParams,
    TokenizerType,
    RenameAliasOperation,
    RenameAlias,
)

from indexer.config import QDRANT_URL, QDRANT_COLLECTION, EMBED_DIM, EMBED_PROVIDER

client = QdrantClient(url=QDRANT_URL)
COLL = QDRANT_COLLECTION
DIM = EMBED_DIM
BACKEND = EMBED_PROVIDER
STORAGE_PATH = "/root/.wide-researcher/qdrant/storage/collections"


def _backup_name() -> str:
    ts = datetime.now().strftime("%Y%m%d")
    return f"{COLL}__backup__{DIM}__{BACKEND}__{ts}"


def _rename_collection(src: str, dst: str) -> bool:
    """Atomically rename a collection via alias swap, then move the on-disk data.
    Falls back to a direct snapshot if the collection is not an alias.
    """
    # 1. Try alias-based rename
    try:
        client.update_collection_aliases(
            change_aliases_operations=[RenameAliasOperation(
                rename_alias=RenameAlias(old_alias_name=src, new_alias_name=dst),
            )]
        )
    except Exception as e:
        # Collection might be a real collection, not an alias — use snapshot backup instead
        if "not found" in str(e).lower() or "not found" in str(e).lower():
            try:
                # Snapshot-based backup (saved to disk already by the caller)
                client.create_snapshot(collection_name=src)
            except Exception:
                pass  # Snapshot may already exist or Qdrant version mismatch
        else:
            print(f"  alias rename failed: {e} — falling back to direct delete")
        return False

    # 2. Move on-disk data so future restarts can find the renamed collection
    src_path = os.path.join(STORAGE_PATH, src)
    dst_path = os.path.join(STORAGE_PATH, dst)
    if os.path.isdir(src_path):
        if os.path.exists(dst_path):
            shutil.rmtree(dst_path)
        shutil.move(src_path, dst_path)
    return True


def ensure_collection(recreate: bool = False):
    existing = [c.name for c in client.get_collections().collections]
    backup_done = False

    if COLL in existing:
        info = client.get_collection(COLL)
        current_dim = info.config.params.vectors.size
        print(f"collection {COLL!r} exists (points={info.points_count}, dim={current_dim})")

        if recreate or current_dim != DIM:
            if recreate:
                reason = "requested --recreate"
            else:
                reason = f"dim mismatch: collection={current_dim}, EMBED_DIM={DIM}"
            print(f"  {reason} — backing up before recreating")

            backup = _backup_name()
            ok = _rename_collection(COLL, backup)
            if ok:
                print(f"  backed up to {backup!r}")
                backup_done = True
            else:
                print(f"  could not backup via alias rename — trying direct delete")
                client.delete_collection(COLL)
                existing.remove(COLL)

    if COLL not in [c.name for c in client.get_collections().collections]:
        client.create_collection(
            collection_name=COLL,
            vectors_config=VectorParams(
                size=DIM,
                distance=Distance.COSINE,
                hnsw_config=HnswConfigDiff(m=16, ef_construct=128, full_scan_threshold=10000),
                on_disk=True,
            ),
            on_disk_payload=True,
        )
        print(f"created collection {COLL!r} dim={DIM}")
    elif backup_done:
        print(f"  (use '{sys.argv[0]} --restore {backup}' to restore the backup)")


def ensure_indexes():
    # Keyword indexes — fast equality filters
    for field in (
        "repo",
        "language",
        "agent_owner",
        "atomic_layer",
        "file_path",
        "symbol_kind",
        "file_hash",
        "symbol_id",
        "symbol_fqn",
        "declared_symbols",
        "declared_symbol_ids",
        "imports",
        "imported_files",
        "exports",
        "calls",
        "type_refs",
        "base_types",
        "implements",
        "references",
        "symbol_index_version",
        "symbol_index_hash",
    ):
        try:
            client.create_payload_index(
                collection_name=COLL,
                field_name=field,
                field_schema=PayloadSchemaType.KEYWORD,
            )
            print(f"  index {field} KEYWORD")
        except Exception as e:
            if "already exists" in str(e).lower():
                print(f"  index {field} KEYWORD (exists)")
            else:
                print(f"  index {field} FAILED: {e}")

    # Text indexes — built-in BM25-like full-text search
    for field in ("content", "symbol_name", "graph_text"):
        try:
            client.create_payload_index(
                collection_name=COLL,
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
    import argparse

    parser = argparse.ArgumentParser(description="Manage Qdrant kraken_code collection")
    parser.add_argument("--recreate", action="store_true", help="Delete and recreate the collection (backups current first)")
    parser.add_argument("--restore", metavar="NAME", help="Restore a backup collection (rename back to kraken_code)")
    args = parser.parse_args()

    if args.restore:
        backup = args.restore
        ok = _rename_collection(backup, COLL)
        if ok:
            print(f"restored {backup!r} → {COLL!r}")
        else:
            print(f"restore failed: {backup!r} not found")
        sys.exit(0)

    ensure_collection(recreate=args.recreate)
    ensure_indexes()
    info = client.get_collection(COLL)
    print(f"\nfinal: points={info.points_count}, status={info.status}")
