"""Long-lived embed + rerank worker for the MCP server.

Uses the Cohere API (same as the indexer) so embeddings are 1536-dim
and match the Qdrant collection dimension.

Reads one JSON line per request on stdin. Each request has an `op` field:

  {"op": "embed", "text": "..."}        -> {"ok": true, "vec": [...]}
  {"op": "rerank", "query": "...",      -> {"ok": true, "scores": [...]}
    "docs": ["...", "..."]}

Loads the rerank cross-encoder once at startup; embeddings go through the
Cohere API directly (no local model needed).
"""
from __future__ import annotations

import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import requests

# Cohere config — same as the indexer (read from env)
COHERE_API_KEY = os.environ.get("COHERE_API_KEY", "")
COHERE_MODEL = os.environ.get("COHERE_EMBED_MODEL", "embed-v4.0")
COHERE_URL = "https://api.cohere.ai/v2/embed"
EMBED_DIM = int(os.environ.get("COHERE_EMBED_DIM", "1536"))

# Max concurrent Cohere requests (avoid rate limiting)
_executor = ThreadPoolExecutor(max_workers=8)

# Load cross-encoder reranker at startup (optional — graceful fallback if unavailable)
_reranker = None
if os.environ.get("DISABLE_RERANK", "") != "1":
    try:
        from fastembed.rerank.cross_encoder import TextCrossEncoder
        RERANK_MODEL = os.environ.get("RERANK_MODEL", "Xenova/ms-marco-MiniLM-L-6-v2")
        _reranker = TextCrossEncoder(RERANK_MODEL)
    except Exception as e:
        sys.stderr.write(f"[embed_worker] rerank model unavailable: {e}\n")

# ── Cohere embed ─────────────────────────────────────────────────────────────

def _embed_one(text: str) -> list[float]:
    """Embed a single text via Cohere API (search_query type)."""
    if not COHERE_API_KEY:
        raise RuntimeError("COHERE_API_KEY env not set")

    payload = {
        "model": COHERE_MODEL,
        "input_type": "search_query",
        "embedding_types": ["float"],
        "texts": [text[:4096]],
    }
    headers = {
        "Authorization": f"Bearer {COHERE_API_KEY}",
        "Content-Type": "application/json",
    }

    backoff = 1.0
    last_err = None
    for attempt in range(1, 4):
        try:
            resp = requests.post(COHERE_URL, json=payload, headers=headers, timeout=30)
            if resp.status_code == 200:
                data = resp.json()
                floats = data.get("embeddings", {}).get("float")
                if floats and len(floats) == 1:
                    return floats[0]
                raise RuntimeError(f"Cohere returned unexpected shape: {data}")
            if resp.status_code in (429,) or resp.status_code >= 500:
                last_err = f"Cohere {resp.status_code}"
                time.sleep(backoff)
                backoff *= 2
                continue
            # Auth / bad request — don't retry
            raise RuntimeError(f"Cohere API error {resp.status_code}: {resp.text[:200]}")
        except (requests.ConnectionError, requests.Timeout) as e:
            last_err = f"Cohere unreachable: {e}"
            time.sleep(backoff)
            backoff *= 2

    raise RuntimeError(f"Cohere embed failed after 3 retries: {last_err}")


def _embed_batch(texts: list[str]) -> list[list[float]]:
    """Embed multiple texts via Cohere API (search_document type, batched)."""
    if not texts:
        return []
    if not COHERE_API_KEY:
        raise RuntimeError("COHERE_API_KEY env not set")

    results: list[list[float]] = []
    chunk_size = 96  # Cohere max per request

    for i in range(0, len(texts), chunk_size):
        chunk = [t[:4096] for t in texts[i:i + chunk_size]]
        payload = {
            "model": COHERE_MODEL,
            "input_type": "search_document",
            "embedding_types": ["float"],
            "texts": chunk,
        }
        headers = {
            "Authorization": f"Bearer {COHERE_API_KEY}",
            "Content-Type": "application/json",
        }

        backoff = 1.0
        last_err = None
        for attempt in range(1, 4):
            try:
                resp = requests.post(COHERE_URL, json=payload, headers=headers, timeout=60)
                if resp.status_code == 200:
                    data = resp.json()
                    floats = data.get("embeddings", {}).get("float")
                    if not floats:
                        raise RuntimeError(f"Cohere returned no embeddings: {data}")
                    results.extend(floats)
                    break
                if resp.status_code in (429,) or resp.status_code >= 500:
                    last_err = f"Cohere {resp.status_code}"
                    time.sleep(backoff)
                    backoff *= 2
                    continue
                raise RuntimeError(f"Cohere API error {resp.status_code}: {resp.text[:200]}")
            except (requests.ConnectionError, requests.Timeout) as e:
                last_err = f"Cohere unreachable: {e}"
                time.sleep(backoff)
                backoff *= 2

        else:
            raise RuntimeError(f"Cohere batch embed failed after 3 retries: {last_err}")

    return results


# ── Rerank ──────────────────────────────────────────────────────────────────

def _rerank(query: str, docs: list[str]) -> list[float]:
    if not docs:
        return []
    if _reranker is None:
        return [1.0] * len(docs)
    try:
        scores = list(_reranker.rerank(query, docs))
        return [float(s) for s in scores]
    except Exception as e:
        sys.stderr.write(f"[embed_worker] rerank error: {e}\n")
        return [1.0] * len(docs)


# ── Main loop ────────────────────────────────────────────────────────────────

# Signal readiness to the parent (the JS side blocks on this).
sys.stderr.write("EMBED_WORKER_READY\n")
sys.stderr.flush()

for line in sys.stdin:
    line = line.rstrip("\n")
    if not line:
        continue
    try:
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            req = {"op": "embed", "text": line}

        op = req.get("op", "embed")
        if op == "embed":
            vec = _embed_one(req.get("text", ""))
            sys.stdout.write(json.dumps({"ok": True, "vec": vec}) + "\n")
        elif op == "rerank":
            scores = _rerank(req.get("query", ""), req.get("docs", []))
            sys.stdout.write(json.dumps({"ok": True, "scores": scores}) + "\n")
        elif op == "embed_batch":
            vecs = _embed_batch(req.get("texts", []))
            sys.stdout.write(json.dumps({"ok": True, "vecs": vecs}) + "\n")
        else:
            raise ValueError(f"unknown op: {op!r}")
        sys.stdout.flush()
    except Exception as e:
        sys.stderr.write(f"[embed_worker] error: {e}\n")
        sys.stdout.write(json.dumps({"ok": False, "err": str(e)}) + "\n")
        sys.stdout.flush()
