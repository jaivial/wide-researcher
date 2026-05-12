#!/usr/bin/env python3
"""Long-lived embed worker — provider-aware.

Reads one JSON request per stdin line, writes one JSON response:

  {"op": "embed", "text": "..."} → {"ok": true, "vec": [float, …]}

Provider branch comes from `EMBED_PROVIDER` in the project config
(see `indexer.config`). Two backends:

  • "local-minilm": sentence-transformers PyTorch (offline)
  • "cohere":       cohere ClientV2 (cloud, network required)

Signals readiness with `EMBED_WORKER_READY` on stderr after the
backend is loaded (model file mmap'd, or first Cohere ping done).
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

from indexer.embed import embed_query, get_model  # noqa: E402

# Eager-init the backend so the readiness signal is meaningful.
get_model()

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
            vec = embed_query(req["text"])
            sys.stdout.write(json.dumps({"ok": True, "vec": vec}) + "\n")
        else:
            raise ValueError(f"unknown op: {op!r}")
        sys.stdout.flush()
    except Exception as e:  # noqa: BLE001
        sys.stdout.write(json.dumps({"ok": False, "err": str(e)}) + "\n")
        sys.stdout.flush()
