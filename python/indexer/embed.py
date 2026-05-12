"""Embedding helper — provider-aware.

EMBED_PROVIDER selects the backend:

  • "local-minilm" → sentence-transformers/all-MiniLM-L6-v2 on disk,
    PyTorch CPU. ~22 ms/text on a single core. Stable for hours.

  • "cohere" → Cohere v2 SDK `client.embed(model="embed-v4.0", ...)`.
    1536-d. Live API call per batch. Network-dependent.

Threads are capped to 2 (irrelevant for cohere; matters for local).
"""
from __future__ import annotations

import logging
from typing import Iterable

from .config import (
    BATCH_SIZE,
    EMBED_MODEL,
    EMBED_PROVIDER,
    _load_cohere_key,
)

log = logging.getLogger(__name__)

_model = None  # sentence-transformers handle (local)
_cohere_client = None  # cohere.ClientV2 (cohere provider)


def _as_lists(vecs: Iterable) -> list[list[float]]:
    out: list[list[float]] = []
    for v in vecs:
        if hasattr(v, "tolist"):
            out.append(v.tolist())
        else:
            out.append(list(v))
    return out


# ── local-minilm path ─────────────────────────────────────────────────────────


def _get_local_model():
    global _model
    if _model is None:
        log.info("loading local embedding model: %s", EMBED_MODEL)
        import torch
        torch.set_num_threads(2)
        try:
            torch.set_num_interop_threads(1)
        except RuntimeError:
            pass
        from sentence_transformers import SentenceTransformer
        _model = SentenceTransformer(EMBED_MODEL, device="cpu")
    return _model


def _embed_local_batch(texts: list[str]) -> list[list[float]]:
    m = _get_local_model()
    indexed = sorted(enumerate(texts), key=lambda x: len(x[1]))
    order = [i for i, _ in indexed]
    sorted_texts = [t for _, t in indexed]
    vecs_sorted = _as_lists(
        m.encode(
            sorted_texts,
            batch_size=BATCH_SIZE,
            show_progress_bar=False,
            convert_to_numpy=True,
        )
    )
    out: list[list[float]] = [None] * len(texts)  # type: ignore[list-item]
    for slot, vec in zip(order, vecs_sorted):
        out[slot] = vec
    return out


def _embed_local_query(text: str) -> list[float]:
    m = _get_local_model()
    vecs = _as_lists(m.encode([text], show_progress_bar=False, convert_to_numpy=True))
    return vecs[0]


# ── cohere path ───────────────────────────────────────────────────────────────


def _get_cohere_client():
    global _cohere_client
    if _cohere_client is None:
        try:
            import cohere  # type: ignore[import-not-found]
        except ImportError as e:  # pragma: no cover
            raise RuntimeError(
                "embed_provider=cohere but the `cohere` Python package is not "
                "installed. Did `wide-researcher init` finish? Try "
                "`~/.wide-researcher/venv/bin/pip install cohere` and rerun."
            ) from e
        api_key = _load_cohere_key()
        _cohere_client = cohere.ClientV2(api_key)
    return _cohere_client


def _embed_cohere(texts: list[str], input_type: str) -> list[list[float]]:
    """Embed via Cohere v2 SDK with retry+backoff on transient failures.

    Cohere production tier has rate caps (~100 req/min on default
    production keys). Without retries a single 429 / 5xx kills the
    whole reindex. We retry up to 5 times with exponential backoff
    (1 s, 2 s, 4 s, 8 s, 16 s) on:

      • 429 Too Many Requests
      • 5xx server errors
      • Network timeouts / connection resets
      • cohere SDK's `TooManyRequestsError` / `InternalServerError`

    Persistent auth (401) / bad-request (400) errors fail fast — no retry.
    """
    import time

    client = _get_cohere_client()
    # Cohere v4 caps batch at 96 texts per call; chunk if larger.
    out: list[list[float]] = []
    CHUNK = 96
    MAX_ATTEMPTS = 5

    for i in range(0, len(texts), CHUNK):
        chunk = texts[i : i + CHUNK]
        # Cohere also has a per-text token cap (~512). Truncate any
        # outlier so a single huge chunk doesn't blow up the batch.
        chunk = [t[:4096] for t in chunk]

        backoff = 1.0
        last_err: Exception | None = None
        succeeded = False
        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                resp = client.embed(
                    model=EMBED_MODEL,
                    input_type=input_type,
                    embedding_types=["float"],
                    texts=chunk,
                )
                floats = getattr(resp.embeddings, "float", None)
                if floats is None and isinstance(resp.embeddings, dict):
                    floats = resp.embeddings.get("float")
                if not floats:
                    raise RuntimeError("cohere returned no float embeddings")
                out.extend([list(v) for v in floats])
                succeeded = True
                break
            except Exception as e:  # noqa: BLE001
                msg = str(e).lower()
                # Fast-fail on auth + bad-request errors (no point retrying).
                if (
                    "401" in msg
                    or "unauthorized" in msg
                    or "invalid api token" in msg
                    or ("400" in msg and "rate" not in msg)
                ):
                    raise
                last_err = e
                if attempt < MAX_ATTEMPTS:
                    log.warning(
                        "cohere.embed attempt %d/%d failed (%s); backoff %.1fs",
                        attempt, MAX_ATTEMPTS, type(e).__name__, backoff,
                    )
                    time.sleep(backoff)
                    backoff = min(backoff * 2.0, 30.0)

        if not succeeded:
            raise RuntimeError(
                f"cohere.embed failed after {MAX_ATTEMPTS} attempts: {last_err}"
            ) from last_err

    return out


# ── public API (provider-aware) ───────────────────────────────────────────────


def get_model():
    """Eager-load the model so the indexer's startup-time check sees it."""
    if EMBED_PROVIDER == "local-minilm":
        return _get_local_model()
    if EMBED_PROVIDER == "cohere":
        return _get_cohere_client()
    raise RuntimeError(f"unknown embed_provider: {EMBED_PROVIDER!r}")


def embed_batch(texts: list[str]) -> list[list[float]]:
    """Embed a batch as DOCUMENTS (used for indexing)."""
    if not texts:
        return []
    if EMBED_PROVIDER == "local-minilm":
        return _embed_local_batch(texts)
    if EMBED_PROVIDER == "cohere":
        return _embed_cohere(texts, input_type="search_document")
    raise RuntimeError(f"unknown embed_provider: {EMBED_PROVIDER!r}")


def embed_query(text: str) -> list[float]:
    """Embed a single QUERY (used at search time)."""
    if EMBED_PROVIDER == "local-minilm":
        return _embed_local_query(text)
    if EMBED_PROVIDER == "cohere":
        out = _embed_cohere([text], input_type="search_query")
        return out[0]
    raise RuntimeError(f"unknown embed_provider: {EMBED_PROVIDER!r}")
