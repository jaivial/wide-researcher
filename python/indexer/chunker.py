"""Chunking dispatcher.

AST-aware for ts/tsx/python/go/rust/csharp, heading-based for markdown,
key-based for JSON locales, line-based fallback otherwise. Always
finishes with an oversize-split pass and sequential chunk_index
renumbering.
"""
from __future__ import annotations

import logging

from .chunker_common import (
    Chunk,
    chunk_json_locale,
    chunk_lines_fallback,
    chunk_markdown,
    maybe_split_oversize,
)
from .chunker_ts import chunk_ts
from .chunker_cs import chunk_cs
from .chunker_py import chunk_py
from .chunker_go import chunk_go
from .chunker_rust import chunk_rust

log = logging.getLogger(__name__)


MAX_CHUNKS_PER_FILE = 200


def chunk_file(abs_path: str, language: str, source: str) -> list[Chunk]:
    try:
        if language in ("typescript", "tsx"):
            raw = chunk_ts(language, source)
        elif language == "csharp":
            raw = chunk_cs(source)
        elif language == "python":
            raw = chunk_py(source)
        elif language == "go":
            raw = chunk_go(source)
        elif language == "rust":
            raw = chunk_rust(source)
        elif language == "json":
            if "/locales/" in abs_path or "/lang/" in abs_path or "/i18n/" in abs_path:
                raw = chunk_json_locale(source)
            else:
                raw = chunk_lines_fallback(source, symbol_kind="block")
        elif language == "markdown":
            raw = chunk_markdown(source)
        else:
            raw = chunk_lines_fallback(source, symbol_kind="block")
    except Exception as e:  # noqa: BLE001
        log.warning(
            "parser failure on %s (%s): %s — falling back to line chunking",
            abs_path, language, e,
        )
        raw = chunk_lines_fallback(source, symbol_kind="block")

    if not raw:
        raw = chunk_lines_fallback(source, symbol_kind="block")

    if len(raw) > MAX_CHUNKS_PER_FILE:
        log.warning(
            "chunk-cap hit on %s: %d → %d", abs_path, len(raw), MAX_CHUNKS_PER_FILE
        )
        raw = raw[:MAX_CHUNKS_PER_FILE]

    out: list[Chunk] = []
    for c in raw:
        for sub in maybe_split_oversize(c):
            if sub.content.strip():
                out.append(sub)

    for i, c in enumerate(out):
        c.chunk_index = i
    return out


__all__ = ["chunk_file", "Chunk"]
