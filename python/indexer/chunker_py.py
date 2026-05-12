"""Python AST chunker via tree-sitter-languages."""
from __future__ import annotations

import logging

from tree_sitter_languages import get_parser

from .chunker_common import Chunk, chunk_lines_fallback, find_named_child, slice_lines, tokens

log = logging.getLogger(__name__)

PY_TOP_TYPES = {
    "function_definition",
    "class_definition",
    "decorated_definition",
    "import_statement",
    "import_from_statement",
    "expression_statement",  # module-level assignments / docstring
}


def _name_for_py_node(node) -> str | None:
    t = node.type
    if t == "decorated_definition":
        for c in node.children:
            if c.type in ("function_definition", "class_definition"):
                return _name_for_py_node(c)
        return None
    if t in ("function_definition", "class_definition"):
        return find_named_child(node, "identifier")
    return None


def _kind_for_py_node(node) -> str:
    t = node.type
    if t == "decorated_definition":
        for c in node.children:
            if c.type == "function_definition":
                return "function"
            if c.type == "class_definition":
                return "class"
        return "block"
    return {
        "function_definition": "function",
        "class_definition": "class",
        "import_statement": "imports",
        "import_from_statement": "imports",
        "expression_statement": "block",
    }.get(t, "block")


def chunk_py(source: str) -> list[Chunk]:
    parser = get_parser("python")
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

        if t in ("import_statement", "import_from_statement"):
            pending_imports.append((s, e))
            continue
        flush_imports()

        if t not in PY_TOP_TYPES:
            content = slice_lines(source, s, e)
            if content.strip():
                chunks.append(Chunk(
                    chunk_index=0, start_line=s, end_line=e,
                    symbol_kind="block", symbol_name=None,
                    content=content, content_tokens=tokens(content),
                ))
            continue

        kind = _kind_for_py_node(node)
        name = _name_for_py_node(node)
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
