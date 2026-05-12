#!/usr/bin/env python3
"""Long-lived embed worker for the MCP server.

Reads one JSON request per stdin line, writes one JSON response per
stdout line:

  {"op": "embed", "text": "..."} → {"ok": true, "vec": [float, …]}

Loads the embed model once at startup. Signals readiness with the
literal line `EMBED_WORKER_READY` on stderr — the Node-side wrapper
blocks queued requests until it sees that marker.

Uses sentence-transformers (PyTorch) for consistency with the rest of
the codebase. fastembed was tried; its ONNX runtime leaks
intermediate buffers and OOMs the host after ~65 files.
"""
from __future__ import annotations

import json
import os
import sys

# Cap intra-op threads BEFORE numpy/torch imports.
os.environ.setdefault("OMP_NUM_THREADS", "2")
os.environ.setdefault("ORT_NUM_THREADS", "2")
os.environ.setdefault("MKL_NUM_THREADS", "2")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "2")

_HERE = os.path.dirname(os.path.abspath(__file__))
_PY_ROOT = os.path.dirname(_HERE)
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

# Picks up EMBED_MODEL from the project config pointed at by
# WIDE_RESEARCHER_PROJECT_CONFIG.
from indexer.config import EMBED_MODEL  # noqa: E402

import torch  # noqa: E402

torch.set_num_threads(2)
try:
    torch.set_num_interop_threads(1)
except RuntimeError:
    pass

from sentence_transformers import SentenceTransformer  # noqa: E402

MODEL = SentenceTransformer(EMBED_MODEL, device="cpu")


def _embed_one(text: str) -> list[float]:
    vecs = MODEL.encode([text], show_progress_bar=False, convert_to_numpy=True)
    if vecs is None or len(vecs) == 0:
        raise RuntimeError("empty embedding result")
    v = vecs[0]
    if hasattr(v, "tolist"):
        return v.tolist()
    return [float(x) for x in v]


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
            vec = _embed_one(req["text"])
            sys.stdout.write(json.dumps({"ok": True, "vec": vec}) + "\n")
        else:
            raise ValueError(f"unknown op: {op!r}")
        sys.stdout.flush()
    except Exception as e:  # noqa: BLE001
        sys.stdout.write(json.dumps({"ok": False, "err": str(e)}) + "\n")
        sys.stdout.flush()
