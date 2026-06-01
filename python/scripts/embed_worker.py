"""Embed/rerank worker for the MCP server — now a thin daemon proxy.

Historically this process loaded a model (or called Cohere) directly,
once per MCP session. With many concurrent sessions that meant N
resident models and N copies of the torch leak → host OOM.

It is now a stateless proxy: it forwards every request to the single
shared embed daemon (scripts/embed_daemon.py) over a unix socket and
holds no model itself. The stdin/stdout JSON contract is unchanged, so
the JS side (src/mcp-server/embed.ts) needs no modification.

  {"op": "embed", "text": "..."}        -> {"ok": true, "vec": [...]}
  {"op": "embed_batch", "texts": [...]}  -> {"ok": true, "vecs": [...]}
  {"op": "rerank", "query": "...",       -> {"ok": true, "scores": [...]}
    "docs": ["...", "..."]}
"""
from __future__ import annotations

import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_PY_ROOT = os.path.dirname(_HERE)
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

from indexer.daemon_client import DaemonClient  # noqa: E402

RERANK_DISABLED = os.environ.get("DISABLE_RERANK", "") == "1"

_client = DaemonClient()

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
            vec = _client.embed_query(req.get("text", ""))
            sys.stdout.write(json.dumps({"ok": True, "vec": vec}) + "\n")
        elif op == "rerank":
            docs = req.get("docs", [])
            if RERANK_DISABLED:
                scores = [1.0] * len(docs)
            else:
                scores = _client.rerank(req.get("query", ""), docs)
            sys.stdout.write(json.dumps({"ok": True, "scores": scores}) + "\n")
        elif op == "embed_batch":
            vecs = _client.embed_batch(req.get("texts", []))
            sys.stdout.write(json.dumps({"ok": True, "vecs": vecs}) + "\n")
        else:
            raise ValueError(f"unknown op: {op!r}")
        sys.stdout.flush()
    except Exception as e:
        sys.stderr.write(f"[embed_worker] error: {e}\n")
        sys.stdout.write(json.dumps({"ok": False, "err": str(e)}) + "\n")
        sys.stdout.flush()
