"""Embedding helper.

Uses sentence-transformers (PyTorch). The fastembed/ONNX path leaks
intermediate buffers on real workloads (RSS climbs ~180 MB per file)
and OOMs around file 65 of a fresh reindex. PyTorch is ~2× slower per
embed but stable for hours.

Threads are capped to 2 to keep the indexer's CPU footprint inside
the systemd unit's CPUQuota=200% setting.
"""
from __future__ import annotations

import logging
from typing import Iterable

from .config import EMBED_MODEL, BATCH_SIZE

log = logging.getLogger(__name__)

_model = None


def get_model():
    global _model
    if _model is None:
        log.info("loading embedding model: %s", EMBED_MODEL)
        import torch
        torch.set_num_threads(2)
        try:
            torch.set_num_interop_threads(1)
        except RuntimeError:
            pass
        from sentence_transformers import SentenceTransformer
        _model = SentenceTransformer(EMBED_MODEL, device="cpu")
    return _model


def _as_lists(vecs: Iterable) -> list[list[float]]:
    out: list[list[float]] = []
    for v in vecs:
        if hasattr(v, "tolist"):
            out.append(v.tolist())
        else:
            out.append(list(v))
    return out


def embed_batch(texts: list[str]) -> list[list[float]]:
    """Embed a list of texts. Sort by length to minimise per-batch padding."""
    if not texts:
        return []
    m = get_model()
    indexed = sorted(enumerate(texts), key=lambda x: len(x[1]))
    order = [i for i, _ in indexed]
    sorted_texts = [t for _, t in indexed]
    vecs_sorted = _as_lists(
        m.encode(sorted_texts, batch_size=BATCH_SIZE, show_progress_bar=False, convert_to_numpy=True)
    )
    out: list[list[float]] = [None] * len(texts)  # type: ignore[list-item]
    for slot, vec in zip(order, vecs_sorted):
        out[slot] = vec
    return out


def embed_query(text: str) -> list[float]:
    m = get_model()
    vecs = _as_lists(m.encode([text], show_progress_bar=False, convert_to_numpy=True))
    return vecs[0]
