from __future__ import annotations

import re

from tree_sitter_languages import get_parser

from .symbol_resolver import child_text, compact_name, find_enclosing_symbol, line_slice, node_text, symbol_id, unique, walk_nodes
from .symbol_types import EdgeRecord, FileGraphRecord, SymbolRecord

_TYPE_DECLS = {
    "class_declaration": "class",
    "interface_declaration": "interface",
    "record_declaration": "class",
    "struct_declaration": "class",
    "enum_declaration": "enum",
}
_METHOD_DECLS = {
    "method_declaration": "method",
    "constructor_declaration": "method",
    "destructor_declaration": "method",
    "operator_declaration": "method",
    "conversion_operator_declaration": "method",
}
_BUILTIN_TYPE_RE = re.compile(r"^(string|int|long|bool|void|object|decimal|double|float|char|byte|var|Task|IEnumerable|List|Dictionary)$")


def extract_cs_graph(repo: str, file_path: str, file_hash: str, language: str, source: str) -> FileGraphRecord:
    parser = get_parser("c_sharp")
    root = parser.parse(source.encode("utf-8")).root_node
    record = FileGraphRecord(repo=repo, file_path=file_path, language=language, file_hash=file_hash)
    namespace = _namespace(root)

    for node in root.children:
        if node.type == "using_directive":
            target = _using_name(node)
            if target:
                record.imports.append(target)
                record.edges.append(EdgeRecord("imports", "file", target, file_path, node.start_point[0] + 1, "high"))
        _collect_declarations(node, record, source, namespace, None)

    for node in walk_nodes(root):
        line = node.start_point[0] + 1
        source_id = find_enclosing_symbol(record.symbols, line)
        if node.type == "invocation_expression":
            callee = _invocation_name(node)
            if callee:
                target = compact_name(callee)
                record.calls.append(target)
                record.references.append(target)
                record.edges.append(EdgeRecord("calls", source_id, target, file_path, line, "medium"))
        elif node.type in ("object_creation_expression", "implicit_object_creation_expression"):
            target = _object_type_name(node)
            if target and not _BUILTIN_TYPE_RE.match(target):
                record.type_refs.append(target)
                record.references.append(target)
                record.edges.append(EdgeRecord("type_ref", source_id, target, file_path, line, "medium"))
        elif node.type in ("identifier", "type_identifier", "generic_name"):
            target = compact_name(node_text(node))
            if target and not _BUILTIN_TYPE_RE.match(target) and target[:1].isupper():
                record.type_refs.append(target)

    record.imports = unique(record.imports)
    record.exports = unique(record.exports)
    record.calls = unique(record.calls)
    record.type_refs = unique(record.type_refs)
    record.base_types = unique(record.base_types)
    record.implements = unique(record.implements)
    record.references = unique(record.references)
    return record


def _collect_declarations(node, record: FileGraphRecord, source: str, namespace: str | None, parent: str | None) -> None:
    if node.type in _TYPE_DECLS:
        name = child_text(node, "identifier", "type_identifier")
        if name:
            sym = _add_symbol(record, node, name, _TYPE_DECLS[node.type], source, namespace, parent)
            _collect_base_list(node, record, sym.id)
            parent = sym.fqn or sym.name
    elif node.type in _METHOD_DECLS:
        name = _method_name(node) or _constructor_name(node)
        if name:
            _add_symbol(record, node, name, "method", source, namespace, parent)
    elif node.type == "namespace_declaration":
        namespace = _namespace(node) or namespace

    for child in node.children:
        _collect_declarations(child, record, source, namespace, parent)


def _add_symbol(record: FileGraphRecord, node, name: str, kind: str, source: str, namespace: str | None, parent: str | None) -> SymbolRecord:
    start = node.start_point[0] + 1
    end = node.end_point[0] + 1
    container = parent or namespace
    fqn = f"{container}.{name}" if container else name
    sym = SymbolRecord(
        id=symbol_id(record.file_path, name, kind, start),
        name=name,
        kind=kind,
        file_path=record.file_path,
        language=record.language,
        start_line=start,
        end_line=end,
        fqn=fqn,
        signature=_signature(line_slice(source, start, min(end, start + 8))),
        confidence="high",
    )
    record.symbols.append(sym)
    if kind in ("class", "interface", "enum") or _is_public(node):
        record.exports.append(name)
        record.edges.append(EdgeRecord("exports", sym.id, name, record.file_path, start, "high"))
    return sym


def _collect_base_list(node, record: FileGraphRecord, source_id: str) -> None:
    for child in node.children:
        if child.type == "base_list":
            for name in _identifier_descendants(child):
                if name.startswith("I") and len(name) > 1 and name[1:2].isupper():
                    record.implements.append(name)
                    record.edges.append(EdgeRecord("implements", source_id, name, record.file_path, child.start_point[0] + 1, "high"))
                else:
                    record.base_types.append(name)
                    record.edges.append(EdgeRecord("extends", source_id, name, record.file_path, child.start_point[0] + 1, "high"))


def _namespace(root) -> str | None:
    for node in walk_nodes(root):
        if node.type in ("namespace_declaration", "file_scoped_namespace_declaration"):
            for child in node.children:
                if child.type in ("identifier", "qualified_name"):
                    return node_text(child)
    return None


def _using_name(node) -> str | None:
    for child in node.children:
        if child.type in ("identifier", "qualified_name"):
            return node_text(child)
    return None


def _invocation_name(node) -> str | None:
    for child in node.children:
        if child.type in ("member_access_expression", "identifier", "generic_name"):
            return node_text(child)
    return None


def _object_type_name(node) -> str | None:
    for child in walk_nodes(node):
        if child.type in ("identifier", "type_identifier", "generic_name"):
            return compact_name(node_text(child))
    return None


def _identifier_descendants(node) -> list[str]:
    out = []
    for child in walk_nodes(node):
        if child.type in ("identifier", "type_identifier", "generic_name"):
            name = compact_name(node_text(child))
            if name and not _BUILTIN_TYPE_RE.match(name):
                out.append(name)
    return unique(out)


def _method_name(node) -> str | None:
    identifiers = [node_text(child) for child in node.children if child.type in ("identifier", "type_identifier")]
    if not identifiers:
        return None
    if len(identifiers) > 1:
        return identifiers[-1]
    return identifiers[0]


def _constructor_name(node) -> str | None:
    for child in node.children:
        if child.type in ("identifier", "type_identifier"):
            return node_text(child)
    return None


def _is_public(node) -> bool:
    text = node_text(node)[:120]
    return "public " in text or "export " in text


def _signature(text: str) -> str:
    lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped:
            lines.append(stripped)
        if len(lines) >= 3:
            break
    return " ".join(lines)[:500]
