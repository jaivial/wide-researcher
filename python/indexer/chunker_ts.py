"""TypeScript / TSX AST chunker via tree-sitter-languages."""
from __future__ import annotations

import logging

from tree_sitter_languages import get_parser

from .chunker_common import Chunk, chunk_lines_fallback, find_named_child, slice_lines, tokens

log = logging.getLogger(__name__)

TS_TOP_TYPES = {
    "function_declaration",
    "class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "lexical_declaration",
    "variable_statement",
    "export_statement",
    "import_statement",
}

TS_SMALL_GROUPABLE = {"interface_declaration", "type_alias_declaration"}


def _name_for_ts_node(node) -> str | None:
    t = node.type
    if t == "export_statement":
        for c in node.children:
            if c.type in TS_TOP_TYPES and c.type != "export_statement":
                return _name_for_ts_node(c)
        return None
    if t == "function_declaration":
        return find_named_child(node, "identifier")
    if t in ("class_declaration", "interface_declaration", "type_alias_declaration"):
        return find_named_child(node, "type_identifier", "identifier")
    if t == "enum_declaration":
        return find_named_child(node, "identifier", "type_identifier")
    if t in ("lexical_declaration", "variable_statement"):
        for c in node.children:
            if c.type == "variable_declarator":
                return find_named_child(c, "identifier", "type_identifier")
    return None


def _kind_for_ts_node(node) -> str:
    t = node.type
    if t == "export_statement":
        for c in node.children:
            if c.type in TS_TOP_TYPES and c.type != "export_statement":
                return _kind_for_ts_node(c)
        return "export"
    return {
        "function_declaration": "function",
        "class_declaration": "class",
        "interface_declaration": "interface",
        "type_alias_declaration": "type",
        "enum_declaration": "enum",
        "lexical_declaration": "component",
        "variable_statement": "component",
        "import_statement": "imports",
    }.get(t, "block")


def chunk_ts(language: str, source: str) -> list[Chunk]:
    parser_name = "tsx" if language == "tsx" else "typescript"
    parser = get_parser(parser_name)
    src_bytes = source.encode("utf-8")
    tree = parser.parse(src_bytes)
    root = tree.root_node
    if root is None or not root.children:
        return chunk_lines_fallback(source, symbol_kind="block")

    chunks: list[Chunk] = []
    pending_imports: list[tuple[int, int]] = []
    pending_small: list[tuple] = []  # (start, end, kind, name)

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

    def flush_small():
        if not pending_small:
            return
        s = pending_small[0][0]
        e = pending_small[-1][1]
        names = [p[3] for p in pending_small if p[3]]
        content = slice_lines(source, s, e)
        chunks.append(Chunk(
            chunk_index=0, start_line=s, end_line=e,
            symbol_kind=pending_small[0][2],
            symbol_name=", ".join(names) if names else None,
            content=content, content_tokens=tokens(content),
        ))
        pending_small.clear()

    for node in root.children:
        t = node.type
        s = node.start_point[0] + 1
        e = node.end_point[0] + 1
        if t == "import_statement":
            flush_small()
            pending_imports.append((s, e))
            continue
        flush_imports()

        if t not in TS_TOP_TYPES:
            flush_small()
            content = slice_lines(source, s, e)
            if content.strip():
                chunks.append(Chunk(
                    chunk_index=0, start_line=s, end_line=e,
                    symbol_kind="block", symbol_name=None,
                    content=content, content_tokens=tokens(content),
                ))
            continue

        inner = node
        if t == "export_statement":
            for c in node.children:
                if c.type in TS_TOP_TYPES and c.type != "export_statement":
                    inner = c
                    break

        kind = _kind_for_ts_node(node)
        name = _name_for_ts_node(node)
        node_lines = e - s + 1

        if inner.type in TS_SMALL_GROUPABLE and node_lines < 30:
            if pending_small and pending_small[-1][2] == kind:
                pending_small.append((s, e, kind, name))
            else:
                flush_small()
                pending_small.append((s, e, kind, name))
            continue

        flush_small()
        content = slice_lines(source, s, e)
        if not content.strip():
            continue
        chunks.append(Chunk(
            chunk_index=0, start_line=s, end_line=e,
            symbol_kind=kind, symbol_name=name,
            content=content, content_tokens=tokens(content),
        ))

    flush_imports()
    flush_small()
    return chunks
