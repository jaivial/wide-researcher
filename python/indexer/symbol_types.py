from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

SYMBOL_INDEX_VERSION = "1"


@dataclass
class SymbolRecord:
    id: str
    name: str
    kind: str
    file_path: str
    language: str
    start_line: int
    end_line: int
    fqn: str | None = None
    signature: str | None = None
    confidence: str = "high"

    def to_payload(self, repo: str) -> dict[str, Any]:
        return {
            "node_id": self.id,
            "kind": self.kind,
            "name": self.name,
            "fqn": self.fqn or self.name,
            "file_path": self.file_path,
            "repo": repo,
            "language": self.language,
            "start_line": self.start_line,
            "end_line": self.end_line,
            "signature": self.signature or "",
            "confidence": self.confidence,
        }


@dataclass
class EdgeRecord:
    kind: str
    source: str
    target: str
    file_path: str
    line: int
    confidence: str = "medium"


@dataclass
class FileGraphRecord:
    repo: str
    file_path: str
    language: str
    file_hash: str
    symbols: list[SymbolRecord] = field(default_factory=list)
    edges: list[EdgeRecord] = field(default_factory=list)
    imports: list[str] = field(default_factory=list)
    imported_files: list[str] = field(default_factory=list)
    exports: list[str] = field(default_factory=list)
    calls: list[str] = field(default_factory=list)
    type_refs: list[str] = field(default_factory=list)
    base_types: list[str] = field(default_factory=list)
    implements: list[str] = field(default_factory=list)
    references: list[str] = field(default_factory=list)

    def payload_for_range(self, start_line: int, end_line: int) -> dict[str, Any]:
        local_symbols = [s for s in self.symbols if _overlaps(s.start_line, s.end_line, start_line, end_line)]
        local_edges = [e for e in self.edges if start_line <= e.line <= end_line]
        declared_symbols = _unique([s.name for s in local_symbols])
        declared_symbol_ids = _unique([s.id for s in local_symbols])
        calls = _unique([e.target for e in local_edges if e.kind == "calls"])
        type_refs = _unique([e.target for e in local_edges if e.kind == "type_ref"])
        base_types = _unique([e.target for e in local_edges if e.kind == "extends"])
        implements = _unique([e.target for e in local_edges if e.kind == "implements"])
        references = _unique([e.target for e in local_edges if e.kind == "references"])
        imports = _unique([e.target for e in local_edges if e.kind == "imports"])
        exports = _unique([e.target for e in local_edges if e.kind == "exports"])

        if not imports and start_line <= 80:
            imports = self.imports[:]
        if not exports:
            exports = [s for s in self.exports if s in declared_symbols] or []

        graph_parts = []
        if declared_symbols:
            graph_parts.append("declares " + " ".join(declared_symbols[:12]))
        if calls:
            graph_parts.append("calls " + " ".join(calls[:20]))
        if imports:
            graph_parts.append("imports " + " ".join(imports[:12]))
        if exports:
            graph_parts.append("exports " + " ".join(exports[:12]))
        if type_refs:
            graph_parts.append("types " + " ".join(type_refs[:20]))
        if base_types:
            graph_parts.append("extends " + " ".join(base_types[:12]))
        if implements:
            graph_parts.append("implements " + " ".join(implements[:12]))

        first = local_symbols[0] if local_symbols else None
        return {
            "symbol_id": first.id if first else "",
            "symbol_fqn": first.fqn or first.name if first else "",
            "declared_symbols": declared_symbols,
            "declared_symbol_ids": declared_symbol_ids,
            "imports": imports,
            "imported_files": self.imported_files if imports else [],
            "exports": exports,
            "calls": calls,
            "type_refs": type_refs,
            "base_types": base_types,
            "implements": implements,
            "references": references,
            "graph_text": "; ".join(graph_parts),
            "symbol_index_version": SYMBOL_INDEX_VERSION,
            "symbol_index_hash": self.file_hash,
        }

    def node_payloads(self) -> list[dict[str, Any]]:
        edge_by_symbol: dict[str, list[EdgeRecord]] = {}
        for edge in self.edges:
            edge_by_symbol.setdefault(edge.source, []).append(edge)

        out = []
        for sym in self.symbols:
            edges = edge_by_symbol.get(sym.id, [])
            calls = _unique([e.target for e in edges if e.kind == "calls"])
            type_refs = _unique([e.target for e in edges if e.kind == "type_ref"])
            base_types = _unique([e.target for e in edges if e.kind == "extends"])
            implements = _unique([e.target for e in edges if e.kind == "implements"])
            exports = [e.target for e in edges if e.kind == "exports"]
            payload = sym.to_payload(self.repo)
            payload.update({
                "calls": calls,
                "imports": self.imports,
                "imported_files": self.imported_files,
                "exports": _unique(exports),
                "type_refs": type_refs,
                "base_types": base_types,
                "implements": implements,
            })
            graph_text = [
                sym.kind,
                sym.name,
                sym.fqn or sym.name,
                sym.signature or "",
            ]
            if calls:
                graph_text.append("calls " + " ".join(calls[:20]))
            if self.imports:
                graph_text.append("imports " + " ".join(self.imports[:12]))
            if exports:
                graph_text.append("exports " + " ".join(exports[:12]))
            if type_refs:
                graph_text.append("types " + " ".join(type_refs[:20]))
            payload["graph_text"] = " ".join(p for p in graph_text if p)
            out.append(payload)
        return out


def _overlaps(a_start: int, a_end: int, b_start: int, b_end: int) -> bool:
    return a_start <= b_end and b_start <= a_end


def _unique(values: list[str]) -> list[str]:
    seen = set()
    out = []
    for value in values:
        v = value.strip() if isinstance(value, str) else ""
        if not v or v in seen:
            continue
        seen.add(v)
        out.append(v)
    return out
