from __future__ import annotations

import re

from tree_sitter_languages import get_parser

from .config import PROJECT_ROOT
from .symbol_resolver import (
    child_text,
    compact_name,
    find_enclosing_symbol,
    line_slice,
    node_text,
    resolve_ts_import,
    symbol_id,
    unique,
    walk_nodes,
)
from .symbol_types import EdgeRecord, FileGraphRecord, SymbolRecord

_DECL_TYPES = {
    "function_declaration": "function",
    "class_declaration": "class",
    "interface_declaration": "interface",
    "type_alias_declaration": "type",
    "enum_declaration": "enum",
}
_IDENTIFIER_TYPES = {"identifier", "type_identifier", "property_identifier"}
_TYPE_REF_NODES = {
    "type_identifier",
    "predefined_type",
    "generic_type",
}
_BUILTIN_TYPE_RE = re.compile(r"^(string|number|boolean|void|null|undefined|unknown|any|never|object|Array|Promise)$")


def extract_ts_graph(repo: str, file_path: str, file_hash: str, language: str, source: str) -> FileGraphRecord:
    parser = get_parser("tsx" if language == "tsx" else "typescript")
    root = parser.parse(source.encode("utf-8")).root_node
    record = FileGraphRecord(repo=repo, file_path=file_path, language=language, file_hash=file_hash)

    for node in root.children:
        if node.type == "import_statement":
            module = _import_module(node)
            if module:
                record.imports.append(module)
                resolved = resolve_ts_import(file_path, module, PROJECT_ROOT)
                if resolved:
                    record.imported_files.append(resolved)
                line = node.start_point[0] + 1
                record.edges.append(EdgeRecord("imports", "file", module, file_path, line, "high"))
            continue
        _collect_declaration(node, record, source, exported=False, namespace=None)

    for node in walk_nodes(root):
        line = node.start_point[0] + 1
        source_id = find_enclosing_symbol(record.symbols, line)
        if node.type == "call_expression":
            callee = _callee_name(node)
            if callee:
                target = compact_name(callee)
                record.calls.append(target)
                record.references.append(target)
                record.edges.append(EdgeRecord("calls", source_id, target, file_path, line, "medium"))
        elif node.type in _TYPE_REF_NODES:
            name = compact_name(node_text(node))
            if name and not _BUILTIN_TYPE_RE.match(name):
                record.type_refs.append(name)
                record.references.append(name)
                record.edges.append(EdgeRecord("type_ref", source_id, name, file_path, line, "medium"))
        elif node.type in ("jsx_opening_element", "jsx_self_closing_element"):
            name = _jsx_name(node)
            if name and name[0].isupper():
                record.references.append(name)
                record.edges.append(EdgeRecord("references", source_id, name, file_path, line, "low"))

    record.imports = unique(record.imports)
    record.imported_files = unique(record.imported_files)
    record.exports = unique(record.exports)
    record.calls = unique(record.calls)
    record.type_refs = unique(record.type_refs)
    record.base_types = unique(record.base_types)
    record.implements = unique(record.implements)
    record.references = unique(record.references)
    return record


def _collect_declaration(node, record: FileGraphRecord, source: str, exported: bool, namespace: str | None) -> None:
    t = node.type
    if t == "export_statement":
        saw_decl = False
        for child in node.children:
            if child.type in _DECL_TYPES or child.type in ("lexical_declaration", "variable_statement"):
                saw_decl = True
                _collect_declaration(child, record, source, exported=True, namespace=namespace)
        if not saw_decl:
            for name in _export_names(node):
                record.exports.append(name)
                record.edges.append(EdgeRecord("exports", "file", name, record.file_path, node.start_point[0] + 1, "high"))
        return

    if t in _DECL_TYPES:
        name = _decl_name(node)
        if not name:
            return
        _add_symbol(record, node, name, _DECL_TYPES[t], source, exported, namespace)
        return

    if t in ("lexical_declaration", "variable_statement"):
        for child in node.children:
            if child.type == "variable_declarator":
                name = child_text(child, "identifier", "type_identifier")
                if name:
                    kind = "component" if name[:1].isupper() else "constant"
                    _add_symbol(record, child, name, kind, source, exported, namespace)
        return

    return


def _add_symbol(record: FileGraphRecord, node, name: str, kind: str, source: str, exported: bool, namespace: str | None) -> None:
    start = node.start_point[0] + 1
    end = node.end_point[0] + 1
    fqn = f"{namespace}.{name}" if namespace else name
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
    if exported:
        record.exports.append(name)
        record.edges.append(EdgeRecord("exports", sym.id, name, record.file_path, start, "high"))
    _collect_type_relations(node, record, sym.id)


def _collect_type_relations(node, record: FileGraphRecord, source_id: str) -> None:
    for child in walk_nodes(node):
        if child.type == "extends_clause":
            for target in _identifier_descendants(child):
                record.base_types.append(target)
                record.edges.append(EdgeRecord("extends", source_id, target, record.file_path, child.start_point[0] + 1, "high"))
        elif child.type == "implements_clause":
            for target in _identifier_descendants(child):
                record.implements.append(target)
                record.edges.append(EdgeRecord("implements", source_id, target, record.file_path, child.start_point[0] + 1, "high"))


def _import_module(node) -> str | None:
    for child in walk_nodes(node):
        if child.type == "string":
            return node_text(child).strip("'\"")
    return None


def _export_names(node) -> list[str]:
    out = []
    for child in walk_nodes(node):
        if child.type in _IDENTIFIER_TYPES:
            text = node_text(child)
            if text not in {"export", "default", "from", "as"}:
                out.append(compact_name(text))
    return unique(out)


def _decl_name(node) -> str | None:
    return child_text(node, "identifier", "type_identifier")


def _callee_name(node) -> str | None:
    for child in node.children:
        if child.type in ("identifier", "member_expression", "subscript_expression", "call_expression"):
            return node_text(child)
    return None


def _jsx_name(node) -> str | None:
    for child in node.children:
        if child.type in ("identifier", "nested_identifier", "member_expression"):
            return compact_name(node_text(child))
    return None


def _identifier_descendants(node) -> list[str]:
    names = []
    for child in walk_nodes(node):
        if child.type in ("identifier", "type_identifier"):
            name = compact_name(node_text(child))
            if name and not _BUILTIN_TYPE_RE.match(name):
                names.append(name)
    return unique(names)


def _signature(text: str) -> str:
    first = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped:
            first.append(stripped)
        if len(first) >= 3:
            break
    return " ".join(first)[:500]
