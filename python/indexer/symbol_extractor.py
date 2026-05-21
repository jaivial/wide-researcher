from __future__ import annotations

from .symbol_types import FileGraphRecord


def extract_file_graph(repo: str, file_path: str, file_hash: str, language: str, source: str) -> FileGraphRecord:
    if language in ("typescript", "tsx"):
        from .symbol_extractor_ts import extract_ts_graph
        return extract_ts_graph(repo, file_path, file_hash, language, source)
    if language == "csharp":
        from .symbol_extractor_cs import extract_cs_graph
        return extract_cs_graph(repo, file_path, file_hash, language, source)
    return FileGraphRecord(repo=repo, file_path=file_path, language=language, file_hash=file_hash)
