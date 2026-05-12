"""Go AST chunker via tree-sitter-languages."""
from __future__ import annotations

import logging

from tree_sitter_languages import get_parser

from .chunker_common import Chunk, chunk_lines_fallback, find_named_child, slice_lines, tokens

log = logging.getLogger(__name__)

GO_TOP_TYPES = {
    "function_declaration",
    "method_declaration",
    "type_declaration",
    "var_declaration",
    "const_declaration",
    "import_declaration",
    "package_clause",
}


def _name_for_go_node(node) -> str | None:
    t = node.type
    if t in ("function_declaration", "method_declaration"):
        return find_named_child(node, "identifier", "field_identifier")
    if t == "type_declaration":
        for c in node.children:
            if c.type == "type_spec":
                return find_named_child(c, "type_identifier", "identifier")
    return None


def _kind_for_go_node(t: str) -> str:
    return {
        "function_declaration": "function",
        "method_declaration": "method",
        "type_declaration": "type",
        "var_declaration": "var",
        "const_declaration": "const",
        "import_declaration": "imports",
        "package_clause": "package",
    }.get(t, "block")


def chunk_go(source: str) -> list[Chunk]:
    parser = get_parser("go")
    src_bytes = source.encode("utf-8")
    tree = parser.parse(src_bytes)
    root = tree.root_node
    if root is None or not root.children:
        return chunk_lines_fallback(source, symbol_kind="block")

    chunks: list[Chunk] = []
    pending_imports: list[tuple[int, int]] = []

    def flush_imports():
        if not pending_imports:
            return
        s = pending_imports[0][0]
        e = pending_imports[-1][1]
        content = slice_lines(source, s, e)
        chunks.append(Chunk(
            chunk_index=0, start_line=s, end_line=e,
            symbol_kind="imports", symbol_name=None,
            content=content, content_tokens=tokens(content),
        ))
        pending_imports.clear()

    for node in root.children:
        t = node.type
        s = node.start_point[0] + 1
        e = node.end_point[0] + 1

        if t == "import_declaration":
            pending_imports.append((s, e))
            continue
        flush_imports()

        if t not in GO_TOP_TYPES:
            content = slice_lines(source, s, e)
            if content.strip():
                chunks.append(Chunk(
                    chunk_index=0, start_line=s, end_line=e,
                    symbol_kind="block", symbol_name=None,
                    content=content, content_tokens=tokens(content),
                ))
            continue

        kind = _kind_for_go_node(t)
        name = _name_for_go_node(node)
        content = slice_lines(source, s, e)
        if not content.strip():
            continue
        chunks.append(Chunk(
            chunk_index=0, start_line=s, end_line=e,
            symbol_kind=kind, symbol_name=name,
            content=content, content_tokens=tokens(content),
        ))

    flush_imports()
    return chunks
