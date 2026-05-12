"""Shared chunking primitives: Chunk dataclass, line slicing, oversize split,
line-based fallback, markdown + JSON-locale chunkers.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass

log = logging.getLogger(__name__)

# Token / char heuristics (1 token ≈ 4 chars)
HARD_CHAR_CAP = 4800
SUB_CHAR_TARGET = 3200          # 800 tokens
SUB_CHAR_OVERLAP = 320          # 80 tokens
FALLBACK_LINES = 80
FALLBACK_OVERLAP_LINES = 8


@dataclass
class Chunk:
    chunk_index: int
    start_line: int   # 1-based, inclusive
    end_line: int     # 1-based, inclusive
    symbol_kind: str | None
    symbol_name: str | None
    content: str
    content_tokens: int


def tokens(s: str) -> int:
    return max(1, len(s) // 4)


def slice_lines(source: str, start_line: int, end_line: int) -> str:
    """1-based inclusive line slice."""
    lines = source.splitlines()
    return "\n".join(lines[start_line - 1 : end_line])


def find_named_child(node, *types) -> str | None:
    """Find first child of given types and return its text (decoded)."""
    for c in node.children:
        if c.type in types:
            return c.text.decode("utf-8", errors="replace")
    return None


def chunk_lines_fallback(source: str, symbol_kind: str = "block") -> list[Chunk]:
    lines = source.splitlines()
    if not lines:
        return []
    chunks: list[Chunk] = []
    step = FALLBACK_LINES - FALLBACK_OVERLAP_LINES
    i = 0
    while i < len(lines):
        s = i
        e = min(i + FALLBACK_LINES, len(lines))
        content = "\n".join(lines[s:e])
        if content.strip():
            chunks.append(Chunk(
                chunk_index=0,
                start_line=s + 1,
                end_line=e,
                symbol_kind=symbol_kind,
                symbol_name=None,
                content=content,
                content_tokens=tokens(content),
            ))
        if e >= len(lines):
            break
        i += step
    return chunks


def _char_split(chunk: Chunk) -> list[Chunk]:
    """Hard char-boundary split for content that can't be line-split
    (single-line dump/minified files). Keeps the embedder from choking on
    20k-token inputs."""
    content = chunk.content
    out: list[Chunk] = []
    step = SUB_CHAR_TARGET - SUB_CHAR_OVERLAP
    sub_idx = 1
    i = 0
    while i < len(content):
        slice_ = content[i : i + SUB_CHAR_TARGET]
        if slice_.strip():
            name = chunk.symbol_name
            new_name = f"{name}:{sub_idx}" if name else f"part:{sub_idx}"
            out.append(Chunk(
                chunk_index=0,
                start_line=chunk.start_line,
                end_line=chunk.end_line,
                symbol_kind=chunk.symbol_kind,
                symbol_name=new_name,
                content=slice_,
                content_tokens=tokens(slice_),
            ))
            sub_idx += 1
        if i + SUB_CHAR_TARGET >= len(content):
            break
        i += step
    return out or [chunk]


def maybe_split_oversize(chunk: Chunk) -> list[Chunk]:
    if len(chunk.content) <= HARD_CHAR_CAP:
        return [chunk]
    lines = chunk.content.splitlines()
    # Single-line oversize (minified JSON, dump files): char-split.
    if len(lines) <= 1:
        return _char_split(chunk)
    out: list[Chunk] = []
    i = 0
    n = len(lines)
    sub_idx = 1
    while i < n:
        acc = []
        char_count = 0
        j = i
        while j < n and char_count < SUB_CHAR_TARGET:
            line = lines[j]
            # Single line bigger than target → char-split that line right here.
            if len(line) > SUB_CHAR_TARGET and not acc:
                tmp = Chunk(
                    chunk_index=0,
                    start_line=chunk.start_line + j,
                    end_line=chunk.start_line + j,
                    symbol_kind=chunk.symbol_kind,
                    symbol_name=chunk.symbol_name,
                    content=line,
                    content_tokens=tokens(line),
                )
                for s in _char_split(tmp):
                    s.symbol_name = (
                        f"{chunk.symbol_name}:{sub_idx}"
                        if chunk.symbol_name
                        else f"part:{sub_idx}"
                    )
                    sub_idx += 1
                    out.append(s)
                j += 1
                i = j
                continue
            acc.append(line)
            char_count += len(line) + 1
            j += 1
        if acc:
            content = "\n".join(acc)
            if content.strip():
                start_line = chunk.start_line + i
                end_line = chunk.start_line + j - 1
                name = chunk.symbol_name
                new_name = f"{name}:{sub_idx}" if name else f"part:{sub_idx}"
                out.append(Chunk(
                    chunk_index=0,
                    start_line=start_line,
                    end_line=end_line,
                    symbol_kind=chunk.symbol_kind,
                    symbol_name=new_name,
                    content=content,
                    content_tokens=tokens(content),
                ))
                sub_idx += 1
        if j >= n:
            break
        overlap_lines = max(2, min(20, len(acc) // 8))
        i = j - overlap_lines
        if i <= 0:
            i = j
    return out or [chunk]


def chunk_json_locale(source: str) -> list[Chunk]:
    try:
        obj = json.loads(source)
    except Exception:
        return chunk_lines_fallback(source, symbol_kind="block")
    if not isinstance(obj, dict):
        return chunk_lines_fallback(source, symbol_kind="block")
    chunks: list[Chunk] = []
    for k, v in obj.items():
        if isinstance(v, (dict, list)):
            content = json.dumps({k: v}, indent=2, ensure_ascii=False)
        else:
            content = json.dumps({k: v}, ensure_ascii=False)
        start = source.find(f'"{k}"')
        s_line = source.count("\n", 0, start) + 1 if start >= 0 else 1
        e_line = s_line + content.count("\n")
        chunks.append(Chunk(
            chunk_index=0,
            start_line=s_line,
            end_line=e_line,
            symbol_kind="section",
            symbol_name=k,
            content=content,
            content_tokens=tokens(content),
        ))
    return chunks


_HEADING_RE = re.compile(r"^(#{1,2})\s+(.*)$")


def chunk_markdown(source: str) -> list[Chunk]:
    lines = source.splitlines()
    positions: list[tuple[int, str]] = []
    for i, line in enumerate(lines):
        m = _HEADING_RE.match(line)
        if m:
            positions.append((i, m.group(2).strip()))
    if not positions:
        return chunk_lines_fallback(source, symbol_kind="section")
    chunks: list[Chunk] = []
    if positions[0][0] > 0:
        lead = "\n".join(lines[: positions[0][0]])
        if lead.strip():
            chunks.append(Chunk(
                chunk_index=0,
                start_line=1,
                end_line=positions[0][0],
                symbol_kind="section",
                symbol_name="(intro)",
                content=lead,
                content_tokens=tokens(lead),
            ))
    for idx, (li, heading) in enumerate(positions):
        end_li = positions[idx + 1][0] - 1 if idx + 1 < len(positions) else len(lines) - 1
        content = "\n".join(lines[li : end_li + 1])
        if not content.strip():
            continue
        chunks.append(Chunk(
            chunk_index=0,
            start_line=li + 1,
            end_line=end_li + 1,
            symbol_kind="section",
            symbol_name=heading,
            content=content,
            content_tokens=tokens(content),
        ))
    return chunks
