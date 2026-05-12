#!/usr/bin/env python3
"""wide-researcher — impact-radius research over a Qdrant code index.

Given a free-form prompt + optional slug, this tool:
  1. Embeds the prompt (MiniLM-L6 via sentence-transformers).
  2. Queries Qdrant for semantic top-K + keyword text match.
  3. Aggregates by file_path with per-file impact weight + symbol roll-up.
  4. Writes a `research-context.json`.
  5. Renders a standalone HTML impact diagram (React Flow).

Project context comes from the JSON file pointed at by the
`WIDE_RESEARCHER_PROJECT_CONFIG` environment variable. The output state
directory defaults to `<project_root>/.wide-researcher/runs/<slug>/`
unless overridden with `--state-dir`.

Usage:
  WIDE_RESEARCHER_PROJECT_CONFIG=/abs/path/.wide-researcher/config.json \\
    python3 -m scripts.wide_research --prompt "<task>"
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import sys
from pathlib import Path

# Cap threads BEFORE torch import (sentence-transformers pulls torch).
os.environ.setdefault("OMP_NUM_THREADS", "2")
os.environ.setdefault("ORT_NUM_THREADS", "2")
os.environ.setdefault("MKL_NUM_THREADS", "2")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "2")

# Ensure the indexer + scripts dirs are importable regardless of CWD.
_HERE = os.path.dirname(os.path.abspath(__file__))
_PY_ROOT = os.path.dirname(_HERE)
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import requests  # noqa: E402

from indexer.config import (  # noqa: E402
    QDRANT_URL,
    QDRANT_COLLECTION,
    EMBED_MODEL,
    PROJECT_ROOT,
    PROJECT_NAME,
)
from diagram_render import render_html  # noqa: E402

# Per-language weight for impact aggregation.
IMPACT_WEIGHT = {
    "typescript": 1.0, "tsx": 1.0, "csharp": 1.0,
    "python": 1.0, "go": 1.0, "rust": 1.0,
    "json": 0.2, "markdown": 0.3, "css": 0.5, "text": 0.6,
}


# --- embedding -------------------------------------------------------------
# Delegate to the indexer.embed module so all components use the same
# provider branch (local-minilm vs cohere).
from indexer.embed import embed_query  # noqa: E402, F401


# --- qdrant calls ----------------------------------------------------------

def _post(path: str, body: dict) -> dict:
    r = requests.post(f"{QDRANT_URL}{path}", json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def semantic_top(vec: list[float], top_k: int) -> list[dict]:
    body = {
        "query": vec,
        "limit": top_k,
        "with_payload": True,
        "params": {"hnsw_ef": 128},
    }
    res = _post(f"/collections/{QDRANT_COLLECTION}/points/query", body)
    return res.get("result", {}).get("points", [])


def text_top(query: str, top_k: int) -> list[dict]:
    body = {
        "filter": {"must": [{"key": "content", "match": {"text": query}}]},
        "limit": top_k,
        "with_payload": True,
        "with_vector": False,
    }
    res = _post(f"/collections/{QDRANT_COLLECTION}/points/scroll", body)
    return res.get("result", {}).get("points", [])


# --- impact aggregation ----------------------------------------------------

def _weight(language: str | None, file_path: str | None) -> float:
    if file_path and file_path.endswith(".stories.tsx"):
        return 0.3
    if file_path and any(file_path.endswith(s) for s in (
        ".spec.ts", ".test.ts", ".spec.tsx", ".test.tsx",
        "_test.go", "_test.py", "_spec.rb",
    )):
        return 0.5
    if file_path and "/locales/" in file_path:
        return 0.2
    return IMPACT_WEIGHT.get(language or "", 1.0)


def aggregate(points: list[dict], score_key: str = "score") -> dict:
    """Group chunk-level hits by file."""
    by_file: dict[str, dict] = {}
    for pt in points:
        p = pt.get("payload") or {}
        fp = p.get("file_path")
        if not fp:
            continue
        w = _weight(p.get("language"), fp)
        s = pt.get(score_key, 0) or 0
        ent = by_file.setdefault(fp, {
            "file_path": fp,
            "repo": p.get("repo"),
            "language": p.get("language"),
            "role": p.get("role"),
            "atomic_layer": p.get("atomic_layer"),
            "score": 0.0,
            "chunks": 0,
            "symbols": [],
            "lines": [],
        })
        ent["score"] += s * w
        ent["chunks"] += 1
        sym = p.get("symbol_name")
        if sym and sym not in ent["symbols"] and len(ent["symbols"]) < 4:
            ent["symbols"].append(sym)
        sl, el = p.get("start_line"), p.get("end_line")
        if sl and el:
            ent["lines"].append([sl, el])
    return by_file


def _default_state_root() -> Path:
    """Where to write research-context.json + impact-diagram.html when
    `--state-dir` is not supplied."""
    return Path(PROJECT_ROOT) / ".wide-researcher" / "runs"


# --- main ------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(prog="wide-research")
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--plan-slug", default=None)
    ap.add_argument("--top-k", type=int, default=20)
    ap.add_argument("--state-dir", default=None,
                    help="Override state dir. Defaults to <project>/.wide-researcher/runs/<slug>/")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    slug = args.plan_slug or datetime.datetime.now().strftime("wide-%Y%m%d-%H%M%S")
    state_dir = Path(args.state_dir) if args.state_dir else (_default_state_root() / slug)
    state_dir.mkdir(parents=True, exist_ok=True)

    if not args.quiet:
        print(f"[wide-research] slug={slug} dir={state_dir}", file=sys.stderr)

    # 1) embed + query
    vec = embed_query(args.prompt)
    sem = semantic_top(vec, args.top_k * 3)
    kw = text_top(args.prompt, args.top_k * 3)

    # 2) aggregate per file (semantic + keyword presence boost)
    files_sem = aggregate(sem, "score")
    files_kw = aggregate(kw, "score")
    merged: dict[str, dict] = dict(files_sem)
    for fp, ent in files_kw.items():
        if fp in merged:
            merged[fp]["score"] += 0.15 * ent["chunks"]
        else:
            ent["score"] = 0.15 * ent["chunks"]
            merged[fp] = ent

    ranked = sorted(merged.values(), key=lambda x: x["score"], reverse=True)[: args.top_k]

    # 3) compose research-context.json
    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    out_json = {
        "planSlug": slug,
        "createdAt": now_iso,
        "prompt": args.prompt,
        "researcher": "wide-researcher",
        "project": PROJECT_NAME,
        "projectRoot": PROJECT_ROOT,
        "collection": QDRANT_COLLECTION,
        "matchedFiles": [
            {
                "path": f["file_path"],
                "repo": f.get("repo"),
                "language": f.get("language"),
                "matches": f["chunks"],
                "score": round(f["score"], 4),
                "role": f.get("role"),
                "atomic_layer": f.get("atomic_layer"),
                "top_symbols": f["symbols"][:3],
                "line_hits": f["lines"][:3],
                "sources": (
                    ["semantic", "keyword"]
                    if f["file_path"] in files_kw and f["file_path"] in files_sem
                    else (["semantic"] if f["file_path"] in files_sem else ["keyword"])
                ),
            }
            for f in ranked
        ],
        "candidateRoles": sorted({f.get("role") for f in ranked if f.get("role")}),
        "candidateLayers": sorted({f.get("atomic_layer") for f in ranked if f.get("atomic_layer")}),
        "flags": {
            "filesLikelyTouched": len(ranked),
        },
        "wideResearch": {
            "diagramPath": str(state_dir / "impact-diagram.html"),
            "topK": args.top_k,
            "semanticHits": len(sem),
            "keywordHits": len(kw),
        },
    }
    json_path = state_dir / "research-context.json"
    tmp = json_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(out_json, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(json_path)

    # 4) html diagram
    html_doc = render_html(args.prompt, ranked, slug, now_iso, project_root=PROJECT_ROOT)
    html_path = state_dir / "impact-diagram.html"
    html_path.write_text(html_doc, encoding="utf-8")

    if not args.quiet:
        print(f"[wide-research] wrote {json_path}")
        print(f"[wide-research] wrote {html_path}")

    # Stdout summary (compatible with auto-injection hooks).
    print(json.dumps({
        "researcher": "wide-researcher",
        "planSlug": slug,
        "researchContext": str(json_path),
        "impactDiagram": str(html_path),
        "filesLikelyTouched": len(ranked),
        "candidateRoles": out_json["candidateRoles"],
        "topFiles": [m["path"] for m in out_json["matchedFiles"][:10]],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
