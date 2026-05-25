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
from .config import CHUNK_CAP

log = logging.getLogger(__name__)


# Priority for chunk-cap eviction. Higher = kept first. Anything not listed
# falls into "block" (lowest tier). Order matters: class > module > function
# > method > component > block.
_SYMBOL_KIND_PRIORITY: dict[str, int] = {
    "class": 100,
    "interface": 95,
    "type": 90,
    "enum": 88,
    "module": 80,
    "namespace": 78,
    "trait": 75,
    "impl": 72,
    "function": 70,
    "method": 65,
    "component": 60,
    "hook": 55,
    "section": 40,  # markdown headings, JSON-locale keys
    "block": 10,
}


def _kind_priority(kind: str | None) -> int:
    return _SYMBOL_KIND_PRIORITY.get(kind or "block", 10)


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

    if len(raw) > CHUNK_CAP:
        log.warning(
            "chunk-cap hit on %s: %d → %d (priority-pruned, kept high-value symbols)",
            abs_path, len(raw), CHUNK_CAP,
        )
        # Priority prune: keep the highest-value chunks instead of silently
        # dropping the tail of the file. Preserves original order so chunk
        # neighbors stay coherent (small tweak — sort indices, then materialise).
        ordered = sorted(
            enumerate(raw),
            key=lambda iv: (-_kind_priority(iv[1].symbol_kind), iv[0]),
        )
        keep_indices = sorted(i for i, _ in ordered[:CHUNK_CAP])
        raw = [raw[i] for i in keep_indices]

    out: list[Chunk] = []
    for c in raw:
        for sub in maybe_split_oversize(c):
            if sub.content.strip():
                out.append(sub)

    for i, c in enumerate(out):
        c.chunk_index = i
    return out


__all__ = ["chunk_file", "Chunk"]
