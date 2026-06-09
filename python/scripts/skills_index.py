"""Index SKILL.md / agents/*.md / references/*.md into the `<collection>_skills`
Qdrant collection.

Walks four sources (auto-discovered):

  1. <project_root>/.claude/skills/**/SKILL.md       (scope=project, file_kind=skill)
  2. <project_root>/.claude/skills/**/references/*.md (scope=project, file_kind=reference)
  3. <project_root>/.claude/agents/*.md              (scope=project, file_kind=agent)
  4. ~/.claude/skills/**/SKILL.md + references/*.md   (scope=global,  file_kind=skill|reference)
  5. ~/.claude/agents/*.md                           (scope=global,  file_kind=agent)

YAML frontmatter (when present) is parsed for `name`, `description`, and
comma-split `triggers`. Bodies are chunked on `## ` / `### ` headings so
each chunk is a single, retrievable section. Chunks are embedded via the
configured `EmbedProvider` (cohere / local-minilm / etc.) and upserted
into `SKILLS_COLLECTION` with deterministic UUIDs (idempotent re-runs).

Re-runs replace all chunks for a given path (delete-then-upsert) and
prune the skills collection for files that no longer exist on disk.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from indexer.config import (
    EMBED_PROVIDER,
    PROJECT_NAME,
    PROJECT_ROOT,
    SKILLS_COLLECTION,
)
from indexer.db import (
    delete_skill_points,
    get_client,
    upsert_skill,
)
from indexer.embed import embed_batch, embed_query, teardown_provider
from qdrant_client import QdrantClient

# `embed_query` is unused at index time but importing it triggers eager
# provider construction in some configs; keep the import to surface
# configuration errors early.
_ = embed_query

FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)$", re.DOTALL)
HEADING_RE = re.compile(r"^(#{2,4})\s+(.+?)\s*$", re.MULTILINE)


@dataclass
class SkillDoc:
    skill_name: str
    scope: str
    repo: str
    path: str
    file_kind: str
    description: str
    trigger: str
    body: str


@dataclass
class SkillChunk:
    skill_name: str
    scope: str
    repo: str
    path: str
    file_kind: str
    description: str
    trigger: str
    heading: str
    content: str


def _parse_frontmatter(raw: str) -> tuple[dict, str]:
    """Return ({name, description, triggers}, body). Tolerant — empty if missing."""
    m = FRONTMATTER_RE.match(raw)
    if not m:
        return {}, raw
    fm, body = m.group(1), m.group(2)
    meta: dict = {}
    for line in fm.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            continue
        k, _, v = line.partition(":")
        meta[k.strip().lower()] = v.strip().strip('"').strip("'")
    return meta, body


def _trigger_string(meta: dict) -> str:
    """Coalesce triggers / keywords / tags into a single space-joined string."""
    parts: list[str] = []
    for key in ("triggers", "keywords", "tags"):
        v = meta.get(key) or meta.get(f"{key}_list")
        if not v:
            continue
        if "," in v:
            parts.extend(p.strip() for p in v.split(",") if p.strip())
        else:
            parts.append(v.strip())
    if meta.get("description"):
        # Provide description as a fallback so the TEXT index has signal
        # even when no explicit triggers are declared.
        parts.append(meta["description"])
    return " | ".join(parts)


def _slugify(s: str, fallback: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9._-]+", "-", s).strip("-").lower()
    return s or fallback


def _chunk_markdown(body: str) -> list[tuple[str, str]]:
    """Split a markdown body into [(heading, content), ...] tuples.

    `## ` / `### ` / `#### ` headings split chunks. Pre-heading preamble
    (if any) becomes a synthetic chunk with heading='(intro)'.
    """
    matches = list(HEADING_RE.finditer(body))
    if not matches:
        return [("(intro)", body.strip())]
    chunks: list[tuple[str, str]] = []
    if matches[0].start() > 0:
        preamble = body[: matches[0].start()].strip()
        if preamble:
            chunks.append(("(intro)", preamble))
    for i, m in enumerate(matches):
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        heading = m.group(2).strip()
        content = body[start:end].strip()
        if content:
            chunks.append((heading, content))
    return chunks


def _iter_skill_md(root: Path) -> Iterable[Path]:
    if not root.is_dir():
        return
    yield from root.rglob("SKILL.md")


def _iter_references(root: Path) -> Iterable[Path]:
    if not root.is_dir():
        return
    yield from root.rglob("references/*.md")


def _iter_agents(root: Path) -> Iterable[Path]:
    agents = root / "agents"
    if not agents.is_dir():
        return
    for p in agents.glob("*.md"):
        if p.is_file():
            yield p


def discover_sources(project_root: Path) -> list[tuple[Path, str, str]]:
    """Return [(abs_path, scope, file_kind), ...] for every skill corpus file."""
    sources: list[tuple[Path, str, str]] = []

    project_claude = project_root / ".claude"
    if project_claude.is_dir():
        for p in _iter_skill_md(project_claude / "skills"):
            sources.append((p, "project", "skill"))
        for p in _iter_references(project_claude / "skills"):
            sources.append((p, "project", "reference"))
        for p in _iter_agents(project_claude):
            sources.append((p, "project", "agent"))

    global_claude = Path(os.path.expanduser("~/.claude"))
    if global_claude.is_dir():
        for p in _iter_skill_md(global_claude / "skills"):
            sources.append((p, "global", "skill"))
        for p in _iter_references(global_claude / "skills"):
            sources.append((p, "global", "reference"))
        for p in _iter_agents(global_claude):
            sources.append((p, "global", "agent"))

    return sources


def build_chunks(path: Path, scope: str, file_kind: str) -> list[SkillChunk]:
    raw = path.read_text(encoding="utf-8", errors="replace")
    meta, body = _parse_frontmatter(raw)
    skill_name = _slugify(
        meta.get("name") or path.parent.name or path.stem,
        fallback=path.stem,
    )
    description = meta.get("description", "")
    trigger = _trigger_string(meta)
    repo = PROJECT_NAME
    abs_path = str(path.resolve())

    chunks: list[SkillChunk] = []
    for heading, content in _chunk_markdown(body):
        chunks.append(
            SkillChunk(
                skill_name=skill_name,
                scope=scope,
                repo=repo,
                path=abs_path,
                file_kind=file_kind,
                description=description,
                trigger=trigger,
                heading=heading,
                content=content,
            )
        )
    return chunks


def _hash_chunks(chunks: list[SkillChunk]) -> str:
    h = hashlib.sha256()
    for c in chunks:
        h.update(c.skill_name.encode())
        h.update(b"\x00")
        h.update(c.heading.encode())
        h.update(b"\x00")
        h.update(c.content.encode())
        h.update(b"\x00")
    return h.hexdigest()


def _already_indexed(abs_path: str, content_hash: str, client: QdrantClient) -> bool:
    """Return True if every point for this path has the matching content_hash.

    We piggyback the hash into a synthetic field via the `description` field
    sentinel; simpler: rely on file mtime + a tiny sidecar.
    """
    sidecar = Path(os.path.expanduser("~/.wide-researcher/state/skills_index.json"))
    if not sidecar.is_file():
        return False
    try:
        import json
        with sidecar.open(encoding="utf-8") as f:
            data = json.load(f)
    except Exception:  # noqa: BLE001
        return False
    return data.get(abs_path) == content_hash


def _mark_indexed(abs_path: str, content_hash: str) -> None:
    sidecar = Path(os.path.expanduser("~/.wide-researcher/state/skills_index.json"))
    sidecar.parent.mkdir(parents=True, exist_ok=True)
    import json
    if sidecar.is_file():
        try:
            with sidecar.open(encoding="utf-8") as f:
                data = json.load(f)
        except Exception:  # noqa: BLE001
            data = {}
    else:
        data = {}
    data[abs_path] = content_hash
    tmp = sidecar.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, sidecar)


def index_file(
    path: Path, scope: str, file_kind: str, *, force: bool = False, dry_run: bool = False
) -> tuple[int, int]:
    """Index one file. Returns (chunks_indexed, chunks_skipped)."""
    chunks = build_chunks(path, scope, file_kind)
    if not chunks:
        return 0, 0
    abs_path = str(path.resolve())
    content_hash = _hash_chunks(chunks)
    client = get_client()
    if not force and _already_indexed(abs_path, content_hash, client):
        return 0, len(chunks)
    if dry_run:
        print(f"  [dry-run] would index {abs_path} ({len(chunks)} chunks)")
        return len(chunks), 0

    # Wipe old points for this path so re-runs never leave orphans.
    delete_skill_points(abs_path)

    # Embed in one batch per file — skills files are small.
    texts = [c.content for c in chunks]
    vectors = embed_batch(texts)

    for c, v in zip(chunks, vectors):
        upsert_skill(
            skill_name=c.skill_name,
            scope=c.scope,
            repo=c.repo,
            path=c.path,
            file_kind=c.file_kind,
            description=c.description,
            trigger=c.trigger,
            content=c.content,
            heading=c.heading,
            vector=v,
        )

    _mark_indexed(abs_path, content_hash)
    return len(chunks), 0


def prune_stale(current_paths: set[str]) -> int:
    """Delete points whose `path` is no longer in the discovered set."""
    client = get_client()
    next_offset = None
    seen_paths: set[str] = set()
    while True:
        scroll_args: dict = {"limit": 256, "with_payload": False, "with_vectors": False}
        if next_offset is not None:
            scroll_args["offset"] = next_offset
        points, next_offset = client.scroll(
            collection_name=SKILLS_COLLECTION, **scroll_args
        )
        for pt in points:
            # We need path; refetch with payload in a follow-up scroll.
            pass
        if not points:
            break
        if next_offset is None:
            break
    # Re-scroll with payloads to collect distinct paths (small dataset, fine)
    next_offset = None
    seen_paths = set()
    while True:
        scroll_args: dict = {
            "limit": 256,
            "with_payload": True,
            "with_vectors": False,
        }
        if next_offset is not None:
            scroll_args["offset"] = next_offset
        points, next_offset = client.scroll(
            collection_name=SKILLS_COLLECTION, **scroll_args
        )
        for pt in points:
            p = (pt.payload or {}).get("path")
            if isinstance(p, str):
                seen_paths.add(p)
        if next_offset is None:
            break

    gone = [p for p in seen_paths if p not in current_paths]
    for p in gone:
        delete_skill_points(p)
    return len(gone)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Index SKILL.md / agents / references into the skills Qdrant collection")
    parser.add_argument("--force", action="store_true", help="Re-index even when the content hash matches")
    parser.add_argument("--dry-run", action="store_true", help="Discover and parse, but skip embedding/upsert")
    parser.add_argument("--prune", action="store_true", help="Delete points for files that no longer exist on disk")
    parser.add_argument("--embed-provider", default=EMBED_PROVIDER, help="Override embed provider for this run")
    args = parser.parse_args(argv)

    project_root = Path(PROJECT_ROOT)
    sources = discover_sources(project_root)
    print(f"discovered {len(sources)} skill sources under {project_root} + ~/.claude")

    total_indexed = 0
    total_skipped = 0
    current_paths: set[str] = set()
    for path, scope, file_kind in sources:
        if not path.is_file():
            continue
        abs_path = str(path.resolve())
        current_paths.add(abs_path)
        try:
            n, s = index_file(path, scope, file_kind, force=args.force, dry_run=args.dry_run)
            total_indexed += n
            total_skipped += s
            label = "indexed" if not args.dry_run else "would index"
            print(f"  {label} {n} chunks ({scope}/{file_kind}) {abs_path}")
        except Exception as e:  # noqa: BLE001
            print(f"  FAILED {abs_path}: {e}", file=sys.stderr)
            continue

    if args.prune and not args.dry_run:
        removed = prune_stale(current_paths)
        print(f"pruned {removed} stale paths")

    print(f"\nfinal: indexed={total_indexed}, skipped={total_skipped}, collection={SKILLS_COLLECTION}")
    teardown_provider()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
