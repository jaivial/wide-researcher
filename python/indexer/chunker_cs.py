"""C# AST chunker via tree-sitter-languages."""
from __future__ import annotations

import logging

from tree_sitter_languages import get_parser

from .chunker_common import Chunk, chunk_lines_fallback, find_named_child, slice_lines, tokens

log = logging.getLogger(__name__)

CS_TOP_TYPES = {
    "class_declaration",
    "interface_declaration",
    "record_declaration",
    "struct_declaration",
    "enum_declaration",
    "namespace_declaration",
    "file_scoped_namespace_declaration",
}

CS_METHOD_TYPES = {
    "method_declaration",
    "constructor_declaration",
    "destructor_declaration",
    "operator_declaration",
    "conversion_operator_declaration",
}


def _name_for_cs_node(node) -> str | None:
    return find_named_child(node, "identifier", "type_identifier")


def _kind_for_cs(t: str) -> str:
    return {
        "class_declaration": "class",
        "interface_declaration": "interface",
        "record_declaration": "class",
        "struct_declaration": "class",
        "enum_declaration": "enum",
        "namespace_declaration": "namespace",
        "file_scoped_namespace_declaration": "namespace",
        "method_declaration": "method",
        "constructor_declaration": "method",
        "destructor_declaration": "method",
        "operator_declaration": "method",
        "conversion_operator_declaration": "method",
    }.get(t, "block")


def chunk_cs(source: str) -> list[Chunk]:
    parser = get_parser("c_sharp")
    src_bytes = source.encode("utf-8")
    tree = parser.parse(src_bytes)
    root = tree.root_node
    if root is None or not root.children:
        return chunk_lines_fallback(source, symbol_kind="block")

    chunks: list[Chunk] = []

    def add_chunk(node, kind, name, start_line=None, end_line=None, content=None):
        s = start_line if start_line is not None else (node.start_point[0] + 1)
        e = end_line if end_line is not None else (node.end_point[0] + 1)
        text = content if content is not None else slice_lines(source, s, e)
        if not text.strip():
            return
        chunks.append(Chunk(
            chunk_index=0, start_line=s, end_line=e,
            symbol_kind=kind, symbol_name=name,
            content=text, content_tokens=tokens(text),
        ))

    def visit_type(type_node, namespace):
        t = type_node.type
        name = _name_for_cs_node(type_node)
        full_name = f"{namespace}.{name}" if namespace and name else name
        kind = _kind_for_cs(t)
        type_lines = type_node.end_point[0] - type_node.start_point[0] + 1

        methods = []
        nested_types = []
        decl_list = None
        for c in type_node.children:
            if c.type == "declaration_list":
                decl_list = c
                break

        if decl_list is not None:
            for c in decl_list.children:
                if c.type in CS_METHOD_TYPES:
                    methods.append(c)
                elif c.type in CS_TOP_TYPES:
                    nested_types.append(c)

        if type_lines > 120 and methods:
            shell_start = type_node.start_point[0] + 1
            first_method_start = methods[0].start_point[0] + 1
            shell_end_pre = max(shell_start, first_method_start - 1)
            shell_content = slice_lines(source, shell_start, shell_end_pre)
            closing = type_node.end_point[0] + 1
            shell_content += "\n// ...method bodies elided...\n" + slice_lines(source, closing, closing)
            add_chunk(
                type_node,
                kind=("class shell" if kind == "class" else kind),
                name=full_name,
                start_line=shell_start, end_line=closing,
                content=shell_content,
            )
            for m in methods:
                mname = _name_for_cs_node(m)
                full_mname = f"{full_name}.{mname}" if full_name and mname else mname
                add_chunk(m, _kind_for_cs(m.type), full_mname)
            for nt in nested_types:
                visit_type(nt, full_name)
        else:
            add_chunk(type_node, kind, full_name)
            for nt in nested_types:
                visit_type(nt, full_name)

    def visit_namespace(ns_node, parent):
        ident = None
        for c in ns_node.children:
            if c.type in ("identifier", "qualified_name"):
                ident = c.text.decode("utf-8", errors="replace")
                break
        full = f"{parent}.{ident}" if parent and ident else ident
        decl_list = None
        for c in ns_node.children:
            if c.type == "declaration_list":
                decl_list = c
                break
        if decl_list is None:
            return full
        for c in decl_list.children:
            if c.type in CS_TOP_TYPES:
                if c.type in ("namespace_declaration", "file_scoped_namespace_declaration"):
                    visit_namespace(c, full)
                else:
                    visit_type(c, full)
        return full

    file_scoped_ns = None
    for c in root.children:
        if c.type == "file_scoped_namespace_declaration":
            ident = None
            for cc in c.children:
                if cc.type in ("identifier", "qualified_name"):
                    ident = cc.text.decode("utf-8", errors="replace")
                    break
            file_scoped_ns = ident
            continue
        if c.type == "namespace_declaration":
            visit_namespace(c, None)
            continue
        if c.type in CS_TOP_TYPES:
            visit_type(c, file_scoped_ns)

    return chunks
