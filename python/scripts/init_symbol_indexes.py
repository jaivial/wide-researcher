from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from qdrant_client import QdrantClient
from qdrant_client.http.models import PayloadSchemaType, TextIndexParams, TokenizerType

from indexer.config import QDRANT_URL, QDRANT_COLLECTION

KEYWORD_FIELDS = (
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
)
TEXT_FIELDS = ("graph_text",)


def ensure_symbol_payload_indexes(collection_name: str = QDRANT_COLLECTION) -> None:
    client = QdrantClient(url=QDRANT_URL)
    for field in KEYWORD_FIELDS:
        try:
            client.create_payload_index(
                collection_name=collection_name,
                field_name=field,
                field_schema=PayloadSchemaType.KEYWORD,
            )
            print(f"  index {field} KEYWORD")
        except Exception as e:
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
        except Exception as e:
            if "already exists" in str(e).lower():
                print(f"  index {field} TEXT (exists)")
            else:
                print(f"  index {field} FAILED: {e}")


def main() -> int:
    ensure_symbol_payload_indexes()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
