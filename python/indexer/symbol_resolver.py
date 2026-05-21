from __future__ import annotations

import os

_TS_EXTS = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs")
_INDEX_FILES = tuple(f"index{ext}" for ext in _TS_EXTS)


def symbol_id(file_path: str, name: str, kind: str, start_line: int) -> str:
    return f"symbol:{file_path}:{kind}:{name}:{start_line}"


def compact_name(name: str) -> str:
    text = name.strip()
    for sep in (".", "::"):
        if sep in text:
            text = text.split(sep)[-1]
    return text.strip("<>[](){};,")


def resolve_ts_import(file_path: str, module: str, project_root: str) -> str | None:
    if not module.startswith("."):
        return None
    base = os.path.normpath(os.path.join(os.path.dirname(file_path), module))
    candidates = []
    root, ext = os.path.splitext(base)
    if ext in _TS_EXTS and os.path.isfile(base):
        return base
    candidates.extend(root + e for e in _TS_EXTS)
    candidates.extend(os.path.join(base, f) for f in _INDEX_FILES)
    for candidate in candidates:
        if os.path.isfile(candidate) and os.path.abspath(candidate).startswith(project_root):
            return os.path.abspath(candidate)
    return None


def line_slice(source: str, start_line: int, end_line: int, max_chars: int = 500) -> str:
    lines = source.splitlines()
    text = "\n".join(lines[max(0, start_line - 1):end_line])
    return text[:max_chars]


def node_text(node) -> str:
    return node.text.decode("utf-8", errors="replace")


def child_text(node, *types: str) -> str | None:
    for child in node.children:
        if child.type in types:
            return node_text(child)
    return None


def walk_nodes(node):
    yield node
    for child in node.children:
        yield from walk_nodes(child)


def find_enclosing_symbol(symbols, line: int) -> str:
    best = None
    best_span = 10**9
    for sym in symbols:
        if sym.start_line <= line <= sym.end_line:
            span = sym.end_line - sym.start_line
            if span < best_span:
                best = sym.id
                best_span = span
    if best:
        return best
    return symbols[0].id if symbols else "file"


def unique(values: list[str]) -> list[str]:
    seen = set()
    out = []
    for value in values:
        v = value.strip() if isinstance(value, str) else ""
        if not v or v in seen:
            continue
        seen.add(v)
        out.append(v)
    return out
