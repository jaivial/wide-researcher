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
import hashlib
import json
import os
import sys
import time
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
from indexer.embed import embed_query as _raw_embed_query  # noqa: E402

# --- caching ---------------------------------------------------------------
# Shared NDJSON embed cache lives at ~/.wide-researcher/cache/embed.ndjson,
# the same path the MCP server uses. Result cache is per-process JSON keyed
# by sha256(prompt + collection + points_count) with a 5-minute TTL.

CACHE_DIR = Path.home() / ".wide-researcher" / "cache"
EMBED_CACHE_FILE = CACHE_DIR / "embed.ndjson"
RESULT_CACHE_FILE = CACHE_DIR / "wide-research.ndjson"
RESULT_TTL_S = 300


def _embed_key(text: str) -> str:
    model_id = f"{os.environ.get('WIDE_RESEARCHER_EMBED_PROVIDER', '') or 'cohere'}::{EMBED_MODEL}"
    return hashlib.sha256(f"{model_id}\0{text}".encode("utf-8")).hexdigest()


_embed_mem: dict[str, list[float]] = {}
_embed_loaded = False


def _load_embed_cache() -> None:
    global _embed_loaded
    if _embed_loaded:
        return
    _embed_loaded = True
    if not EMBED_CACHE_FILE.exists():
        return
    try:
        with EMBED_CACHE_FILE.open(encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    k = entry.get("k")
                    v = entry.get("v")
                    if isinstance(k, str) and isinstance(v, list):
                        _embed_mem[k] = v
                except Exception:
                    pass
    except Exception:
        pass


def _append_embed_entry(key: str, vec: list[float]) -> None:
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        with EMBED_CACHE_FILE.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({"k": key, "v": vec}) + "\n")
    except Exception:
        pass


def embed_query(text: str) -> list[float]:
    _load_embed_cache()
    key = _embed_key(text)
    cached = _embed_mem.get(key)
    if cached is not None:
        return cached
    vec = _raw_embed_query(text)
    if vec:
        _embed_mem[key] = vec
        _append_embed_entry(key, vec)
    return vec


def _result_key(prompt: str, top_k: int, points_count: int) -> str:
    return hashlib.sha256(
        f"{QDRANT_COLLECTION}\0{points_count}\0{top_k}\0{prompt}".encode("utf-8")
    ).hexdigest()


def _read_result_cache(key: str) -> dict | None:
    if not RESULT_CACHE_FILE.exists():
        return None
    cutoff = time.time() - RESULT_TTL_S
    try:
        with RESULT_CACHE_FILE.open(encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except Exception:
                    continue
                if entry.get("k") == key and entry.get("t", 0) >= cutoff:
                    return entry.get("v")
    except Exception:
        pass
    return None


def _append_result_cache(key: str, payload: dict) -> None:
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        with RESULT_CACHE_FILE.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({"k": key, "t": int(time.time()), "v": payload}) + "\n")
    except Exception:
        pass


def _qdrant_points_count() -> int:
    try:
        r = requests.get(f"{QDRANT_URL}/collections/{QDRANT_COLLECTION}", timeout=10)
        if r.ok:
            return int(r.json().get("result", {}).get("points_count", 0))
    except Exception:
        pass
    return 0


# --- HyDE query expansion --------------------------------------------------
# Conditional hypothetical-document generation. Triggers ONLY when the
# prompt is short and lacks identifier-like substrings (CamelCase, snake_case,
# call syntax). Identifier-heavy prompts want literal match, not paraphrase.

_IDENTIFIER_HINT_RE = __import__("re").compile(r"[A-Z][a-z]+[A-Z]|_[a-zA-Z]|::|\.[a-zA-Z]+\(")


def _looks_identifier_heavy(prompt: str) -> bool:
    return bool(_IDENTIFIER_HINT_RE.search(prompt))


def _hyde_paraphrase(prompt: str, api_key: str) -> str | None:
    """Single Cohere chat call producing one hypothetical code snippet that
    *would* answer the prompt. Embedding that snippet narrows the semantic
    gap between a vague request and code-shaped passages in the index.
    """
    instruction = (
        "Write a short fictional code passage (8-15 lines, no markdown fences) "
        "that would plausibly be the answer to the user's query. Mention the "
        "likely function, class, or module names. Do NOT explain — just emit "
        "the passage."
    )
    payload = {
        "model": "command-r-08-2024",
        "messages": [
            {"role": "system", "content": instruction},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": 220,
        "temperature": 0.2,
    }
    try:
        r = requests.post(
            "https://api.cohere.ai/v2/chat",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=20,
        )
        r.raise_for_status()
        data = r.json()
        msg = data.get("message", {}).get("content", [])
        if isinstance(msg, list) and msg:
            text = msg[0].get("text") if isinstance(msg[0], dict) else None
            if isinstance(text, str) and text.strip():
                return text.strip()
    except Exception as e:
        print(f"[wide-research] HyDE skipped: {e}", file=sys.stderr)
    return None


def maybe_expand_query(prompt: str) -> str:
    """Return the prompt unchanged, or a HyDE-expanded variant if all the
    gating conditions hold. Controlled by env var WIDE_RESEARCHER_HYDE=1.
    """
    if os.environ.get("WIDE_RESEARCHER_HYDE", "") != "1":
        return prompt
    if len(prompt.split()) >= 12:
        return prompt
    if _looks_identifier_heavy(prompt):
        return prompt
    try:
        from indexer.config import SECRETS_PATH, COHERE_API_KEY_FIELD, EMBED_PROVIDER
    except Exception:
        return prompt
    if EMBED_PROVIDER != "cohere" or not SECRETS_PATH:
        return prompt
    try:
        with open(SECRETS_PATH, encoding="utf-8") as fh:
            secrets = json.load(fh)
        api_key = secrets.get(COHERE_API_KEY_FIELD)
    except Exception:
        return prompt
    if not isinstance(api_key, str) or len(api_key) < 20:
        return prompt
    paraphrase = _hyde_paraphrase(prompt, api_key)
    if not paraphrase:
        return prompt
    return f"{prompt}\n\n{paraphrase}"


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


def hybrid_top(vec: list[float], query: str, top_k: int) -> list[dict]:
    """Qdrant native RRF fusion of dense vector + BM25 text-match prefetches.

    Replaces the prior unscored scroll-based keyword leg + flat 0.15*chunks
    boost. Now both legs are real ranked retrievals fused server-side.
    """
    body = {
        "prefetch": [
            {"query": vec, "limit": top_k * 4, "params": {"hnsw_ef": 128}},
            {
                "filter": {"must": [{"key": "content", "match": {"text": query}}]},
                "limit": top_k * 4,
            },
        ],
        "query": {"fusion": "rrf"},
        "limit": top_k,
        "with_payload": True,
    }
    res = _post(f"/collections/{QDRANT_COLLECTION}/points/query", body)
    return res.get("result", {}).get("points", [])


def rerank_documents(query: str, points: list[dict], top_n: int) -> list[dict]:
    """Optional Cohere rerank-3.5 pass over fused candidates.

    Replaces each point's score with the reranker's relevance_score so the
    impact aggregator weights by post-rerank relevance. Falls back silently
    on any rerank error so the diagram still renders.
    """
    if not points or top_n <= 0:
        return points
    docs: list[str] = []
    keep_idx: list[int] = []
    for i, pt in enumerate(points):
        p = pt.get("payload") or {}
        content = p.get("content")
        if isinstance(content, str) and content.strip():
            docs.append(content[:4096])
            keep_idx.append(i)
    if not docs:
        return points
    try:
        from indexer.config import SECRETS_PATH, COHERE_API_KEY_FIELD, EMBED_PROVIDER
    except Exception:
        return points
    if EMBED_PROVIDER != "cohere" or not SECRETS_PATH:
        return points
    try:
        with open(SECRETS_PATH, encoding="utf-8") as fh:
            secrets = json.load(fh)
        api_key = secrets.get(COHERE_API_KEY_FIELD)
    except Exception:
        return points
    if not isinstance(api_key, str) or len(api_key) < 20:
        return points
    try:
        r = requests.post(
            "https://api.cohere.ai/v2/rerank",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": "rerank-v3.5",
                "query": query,
                "documents": docs,
                "top_n": min(top_n, len(docs)),
            },
            timeout=30,
        )
        r.raise_for_status()
        results = r.json().get("results", [])
    except Exception as e:
        print(f"[wide-research] rerank skipped: {e}", file=sys.stderr)
        return points
    reranked: list[dict] = []
    for entry in results:
        idx = entry.get("index")
        score = entry.get("relevance_score", 0.0)
        if idx is None or idx >= len(keep_idx):
            continue
        original = dict(points[keep_idx[idx]])
        original["score"] = float(score)
        reranked.append(original)
    return reranked or points


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
    ap.add_argument("--top-k", type=int, default=100)
    ap.add_argument("--state-dir", default=None,
                    help="Override state dir. Defaults to <project>/.wide-researcher/runs/<slug>/")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    slug = args.plan_slug or datetime.datetime.now().strftime("wide-%Y%m%d-%H%M%S")
    state_dir = Path(args.state_dir) if args.state_dir else (_default_state_root() / slug)
    state_dir.mkdir(parents=True, exist_ok=True)

    if not args.quiet:
        print(f"[wide-research] slug={slug} dir={state_dir}", file=sys.stderr)

    # Result-cache short-circuit (TTL 5 min, busted by points_count change).
    points_count = _qdrant_points_count()
    cache_key = _result_key(args.prompt, args.top_k, points_count)
    cached_payload = _read_result_cache(cache_key)
    if cached_payload is not None:
        json_path = state_dir / "research-context.json"
        json_path.write_text(json.dumps(cached_payload, indent=2, ensure_ascii=False), encoding="utf-8")
        # Reshape matchedFiles → render_html's expected schema (uses
        # `file_path`, `chunks`, `symbols`; we stored `path`, `matches`,
        # `top_symbols`). Cheap reverse mapping keeps the diagram rendering
        # path identical for cold and warm runs.
        rendered = [
            {
                "file_path": m.get("path"),
                "repo": m.get("repo"),
                "language": m.get("language"),
                "role": m.get("role"),
                "atomic_layer": m.get("atomic_layer"),
                "score": m.get("score", 0.0),
                "chunks": m.get("matches", 0),
                "symbols": list(m.get("top_symbols") or []),
                "lines": list(m.get("line_hits") or []),
            }
            for m in cached_payload.get("matchedFiles", [])
        ]
        html_doc = render_html(
            args.prompt,
            rendered,
            slug,
            cached_payload.get("createdAt", ""),
            project_root=PROJECT_ROOT,
        )
        html_path = state_dir / "impact-diagram.html"
        html_path.write_text(html_doc, encoding="utf-8")
        print(json.dumps({
            "researcher": "wide-researcher",
            "planSlug": slug,
            "researchContext": str(json_path),
            "impactDiagram": str(html_path),
            "filesLikelyTouched": cached_payload.get("flags", {}).get("filesLikelyTouched", 0),
            "candidateRoles": cached_payload.get("candidateRoles", []),
            "topFiles": [m.get("path") for m in cached_payload.get("matchedFiles", [])[:10]],
            "cacheHit": True,
        }, ensure_ascii=False))
        return 0

    # 1) embed + hybrid retrieve (server-side RRF fusion).
    # Dense leg uses (optionally HyDE-expanded) prompt; keyword leg sticks
    # with the raw prompt so literal identifiers aren't diluted.
    expanded = maybe_expand_query(args.prompt)
    vec = embed_query(expanded)
    fused = hybrid_top(vec, args.prompt, args.top_k * 3)

    # 2) cross-encoder rerank (Cohere rerank-v3.5) over the fused candidates.
    reranked = rerank_documents(args.prompt, fused, top_n=args.top_k * 2)

    # 3) aggregate per file with reranker scores baked in
    merged = aggregate(reranked, "score")
    ranked = sorted(merged.values(), key=lambda x: x["score"], reverse=True)[: args.top_k]
    files_sem = merged  # retained for downstream `sources` annotation below

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
                "sources": ["hybrid-rrf", "reranked"],
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
            "fusedHits": len(fused),
            "rerankedHits": len(reranked),
        },
    }
    json_path = state_dir / "research-context.json"
    tmp = json_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(out_json, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(json_path)

    # Persist result cache so the next identical prompt (same collection
    # state) short-circuits the embed + Qdrant + rerank round-trip.
    _append_result_cache(cache_key, out_json)

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
