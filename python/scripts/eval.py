#!/usr/bin/env python3
"""Evaluation harness for wide-researcher retrieval quality.

Reads queries from `~/.wide-researcher/eval/queries.jsonl` (one JSON object
per line) and runs each through the current Qdrant + rerank pipeline.

Each line shape:
  {
    "query": "where is auth middleware",
    "expected_files": ["/abs/path/src/auth/middleware.ts", "..."],
    "tags": ["auth"]                                  (optional)
  }

Prints recall@5, recall@10, MRR, and per-stage latency. Use to A/B
gating decisions (rerank on vs off, HyDE on vs off, different per-file
caps) by toggling env vars before each run:

  DISABLE_RERANK=1 python -m scripts.eval
  WIDE_RESEARCHER_HYDE=1 python -m scripts.eval --top-k 30

The harness imports the same `hybrid_top` + `rerank_documents` used by
the live tool, so eval numbers reflect production behaviour exactly.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

# Same threading caps the live tool applies.
os.environ.setdefault("OMP_NUM_THREADS", "2")
os.environ.setdefault("ORT_NUM_THREADS", "2")
os.environ.setdefault("MKL_NUM_THREADS", "2")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "2")

_HERE = os.path.dirname(os.path.abspath(__file__))
_PY_ROOT = os.path.dirname(_HERE)
for path in (_PY_ROOT, _HERE):
    if path not in sys.path:
        sys.path.insert(0, path)

from wide_research import (  # noqa: E402
    embed_query,
    hybrid_top,
    rerank_documents,
    maybe_expand_query,
)


DEFAULT_EVAL_PATH = Path.home() / ".wide-researcher" / "eval" / "queries.jsonl"


def _recall_at(matched: list[str], expected: set[str], k: int) -> float:
    if not expected:
        return 0.0
    top = matched[:k]
    hits = sum(1 for fp in top if fp in expected)
    return hits / len(expected)


def _mrr(matched: list[str], expected: set[str]) -> float:
    for rank, fp in enumerate(matched, start=1):
        if fp in expected:
            return 1.0 / rank
    return 0.0


def _files_from_points(points: list[dict]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for pt in points:
        fp = ((pt.get("payload") or {}).get("file_path"))
        if fp and fp not in seen:
            seen.add(fp)
            out.append(fp)
    return out


def run_one(query: str, top_k: int, rerank_enabled: bool) -> tuple[list[str], dict[str, float]]:
    timings: dict[str, float] = {}
    t0 = time.perf_counter()
    expanded = maybe_expand_query(query)
    timings["expand_ms"] = (time.perf_counter() - t0) * 1000

    t0 = time.perf_counter()
    vec = embed_query(expanded)
    timings["embed_ms"] = (time.perf_counter() - t0) * 1000

    t0 = time.perf_counter()
    fused = hybrid_top(vec, query, top_k * 3)
    timings["retrieve_ms"] = (time.perf_counter() - t0) * 1000

    if rerank_enabled:
        t0 = time.perf_counter()
        fused = rerank_documents(query, fused, top_n=top_k * 2)
        timings["rerank_ms"] = (time.perf_counter() - t0) * 1000

    return _files_from_points(fused), timings


def main() -> int:
    ap = argparse.ArgumentParser(prog="wide-researcher-eval")
    ap.add_argument("--queries", default=str(DEFAULT_EVAL_PATH))
    ap.add_argument("--top-k", type=int, default=20)
    ap.add_argument("--no-rerank", action="store_true",
                    help="Override and disable Cohere rerank for this run.")
    args = ap.parse_args()

    p = Path(args.queries)
    if not p.exists():
        print(f"eval set missing: {p}", file=sys.stderr)
        print("Create it with one JSON object per line, schema:", file=sys.stderr)
        print('  {"query": "...", "expected_files": ["...", "..."]}', file=sys.stderr)
        return 2

    rerank_enabled = not args.no_rerank and os.environ.get("DISABLE_RERANK", "") != "1"

    cases: list[dict] = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        cases.append(json.loads(line))

    if not cases:
        print("no eval queries found", file=sys.stderr)
        return 2

    print(f"queries: {len(cases)} | top_k: {args.top_k} | rerank: {rerank_enabled} | "
          f"hyde: {os.environ.get('WIDE_RESEARCHER_HYDE','0') == '1'}")
    print(f"{'query':<60}  r@5   r@10   MRR   embed   retrieve   rerank")
    print("-" * 120)

    sum_r5 = sum_r10 = sum_mrr = 0.0
    sum_embed = sum_retrieve = sum_rerank = 0.0
    for case in cases:
        q = case.get("query", "")
        expected = {os.path.abspath(p) for p in case.get("expected_files", [])}
        files, timings = run_one(q, args.top_k, rerank_enabled)
        r5 = _recall_at(files, expected, 5)
        r10 = _recall_at(files, expected, 10)
        mrr = _mrr(files, expected)
        sum_r5 += r5
        sum_r10 += r10
        sum_mrr += mrr
        sum_embed += timings.get("embed_ms", 0)
        sum_retrieve += timings.get("retrieve_ms", 0)
        sum_rerank += timings.get("rerank_ms", 0)
        truncated = (q[:57] + "...") if len(q) > 60 else q
        print(
            f"{truncated:<60}  {r5:.2f}  {r10:.2f}  {mrr:.2f}  "
            f"{timings.get('embed_ms', 0):6.0f}  {timings.get('retrieve_ms', 0):7.0f}  "
            f"{timings.get('rerank_ms', 0):6.0f}"
        )

    n = len(cases)
    print("-" * 120)
    print(
        f"{'AVG':<60}  {sum_r5/n:.2f}  {sum_r10/n:.2f}  {sum_mrr/n:.2f}  "
        f"{sum_embed/n:6.0f}  {sum_retrieve/n:7.0f}  {sum_rerank/n:6.0f}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
