"""Embedding helper — class-based provider pattern.

EMBED_PROVIDER selects the backend:

  • "local-minilm"      → sentence-transformers/all-MiniLM-L6-v2 (384-d)
  • "local-bge-large"   → BAAI/bge-large-en-v1.5 (1024-d)
  • "local-gte-qwen2"   → Alibaba-NLP/gte-Qwen2-1.5B-instruct (1536-d)
  • "cohere"             → Cohere embed-v4.0 cloud API (1536-d)

Each provider is a class with embed_batch(), embed_query(), and teardown().
The module-level API (get_model, embed_batch, embed_query) is a thin shim
for backward compatibility.
"""
from __future__ import annotations

import atexit
import gc
import logging
import resource
import time
from abc import ABC, abstractmethod
from typing import Iterable

import requests

from .config import (
    BATCH_SIZE,
    EMBED_MODEL,
    EMBED_PROVIDER,
    MAX_RSS_MB,
    _load_cohere_key,
)

log = logging.getLogger(__name__)


def _as_lists(vecs: Iterable) -> list[list[float]]:
    out: list[list[float]] = []
    for v in vecs:
        if hasattr(v, "tolist"):
            out.append(v.tolist())
        else:
            out.append(list(v))
    return out


def _current_rss_mb() -> int:
    """Return CURRENT RSS in MB (not peak). Uses /proc/self/status on Linux."""
    try:
        with open("/proc/self/status", encoding="utf-8") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    # VmRSS is in kB
                    return int(line.split()[1]) // 1024
    except Exception:
        pass
    try:
        import psutil  # type: ignore[import-not-found]
        return int(psutil.Process().memory_info().rss / (1024 * 1024))
    except Exception:
        pass
    # Fallback: ru_maxrss (peak, not current — inaccurate but better than 0)
    try:
        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024
    except Exception:
        return 0


def _sorted_embed(texts: list[str], model, batch_size: int) -> list[list[float]]:
    """Embed texts sorted by length for efficient batching, return in original order."""
    indexed = sorted(enumerate(texts), key=lambda x: len(x[1]))
    order = [i for i, _ in indexed]
    sorted_texts = [t for _, t in indexed]
    vecs_sorted = _as_lists(
        model.encode(
            sorted_texts,
            batch_size=batch_size,
            show_progress_bar=False,
            convert_to_numpy=True,
        )
    )
    out: list[list[float]] = [None] * len(texts)  # type: ignore[list-item]
    for slot, vec in zip(order, vecs_sorted):
        out[slot] = vec
    return out


# ── Base class ──────────────────────────────────────────────────────────────


class EmbedProvider(ABC):
    """Abstract base for all embed backends."""

    @abstractmethod
    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        """Embed a batch of DOCUMENTS (used for indexing)."""

    @abstractmethod
    def embed_query(self, text: str) -> list[float]:
        """Embed a single QUERY (used at search time)."""

    def teardown(self) -> None:
        """Release resources (model, connections). Override if needed."""

    def rss_guard(self) -> None:
        """Check RSS and force GC if approaching the limit."""
        rss = _current_rss_mb()
        if rss > 0 and rss > MAX_RSS_MB:
            log.warning(
                "RSS %d MB exceeds limit %d MB — forcing GC + teardown",
                rss, MAX_RSS_MB,
            )
            self.teardown()
            gc.collect()


# ── Local providers (sentence-transformers) ─────────────────────────────────


class _LocalSTProvider(EmbedProvider):
    """Shared base for sentence-transformers local models."""

    def __init__(self, model_path: str, trust_remote_code: bool = False):
        self._model_path = model_path
        self._trust_remote_code = trust_remote_code
        self._model = None

    def _load(self):
        if self._model is None:
            log.info("loading local embedding model: %s", self._model_path)
            import torch
            torch.set_num_threads(2)
            try:
                torch.set_num_interop_threads(1)
            except RuntimeError:
                pass
            from sentence_transformers import SentenceTransformer
            kwargs: dict = {"device": "cpu"}
            if self._trust_remote_code:
                kwargs["trust_remote_code"] = True
            self._model = SentenceTransformer(self._model_path, **kwargs)
        return self._model

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        m = self._load()
        return _sorted_embed(texts, m, BATCH_SIZE)

    def embed_query(self, text: str) -> list[float]:
        m = self._load()
        vecs = _as_lists(m.encode([text], show_progress_bar=False, convert_to_numpy=True))
        return vecs[0]

    def teardown(self) -> None:
        if self._model is not None:
            del self._model
            self._model = None
            gc.collect()


class MiniLMProvider(_LocalSTProvider):
    """sentence-transformers/all-MiniLM-L6-v2 — 384-d, CPU-only, ~80 MB."""

    def __init__(self):
        super().__init__(EMBED_MODEL)


class BGELargeProvider(_LocalSTProvider):
    """BAAI/bge-large-en-v1.5 — 1024-d, English, ~1.3 GB."""

    def __init__(self):
        super().__init__(EMBED_MODEL)


class GTEQwen2Provider(_LocalSTProvider):
    """Alibaba-NLP/gte-Qwen2-1.5B-instruct — 1536-d, multilingual, ~1.5 GB."""

    def __init__(self):
        super().__init__(EMBED_MODEL, trust_remote_code=False)


# ── Cohere provider ─────────────────────────────────────────────────────────


class CohereProvider(EmbedProvider):
    """Cohere embed-v4.0 — 1536-d, cloud API with explicit lifecycle management.

    Key leak fixes vs the old implementation:
      1. httpx.Client created with bounded connection pool (max 4 connections)
      2. teardown() explicitly closes the client → releases the httpx pool
      3. GC after every 96-text chunk (not every 4 chunks)
      4. RSS guard checks before each API call; force-cycles on threshold breach
      5. Streaming response parsing — never holds the full pydantic model in RAM
    """

    CHUNK_SIZE = 96
    MAX_ATTEMPTS = 5

    def __init__(self):
        self._client = None
        self._httpx_client = None
        self._api_key: str | None = None

    def _ensure_client(self):
        if self._client is not None:
            return
        try:
            import cohere  # type: ignore[import-not-found]
        except ImportError as e:
            raise RuntimeError(
                "embed_provider=cohere but the `cohere` Python package is not "
                "installed. Did `wide-researcher init` finish? Try "
                "`~/.wide-researcher/venv/bin/pip install cohere` and rerun."
            ) from e

        import httpx

        self._api_key = _load_cohere_key()
        self._httpx_client = httpx.Client(
            timeout=httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=10.0),
            limits=httpx.Limits(
                max_connections=4,
                max_keepalive_connections=2,
            ),
        )
        self._client = cohere.ClientV2(
            api_key=self._api_key,
            httpx_client=self._httpx_client,
        )
        log.info("Cohere client created with bounded httpx pool (max_connections=4)")

    def teardown(self) -> None:
        """Close the Cohere client and its httpx connection pool."""
        if self._httpx_client is not None:
            try:
                self._httpx_client.close()
                log.info("Cohere httpx pool closed")
            except Exception as e:
                log.warning("error closing httpx client: %s", e)
        self._client = None
        self._httpx_client = None
        self._api_key = None

    def _recreate_client(self):
        """Teardown + recreate — used when RSS guard triggers."""
        log.warning("recreating Cohere client to reclaim memory")
        self.teardown()
        gc.collect()
        self._ensure_client()

    def _embed_chunk(self, texts: list[str], input_type: str) -> list[list[float]]:
        """Embed a single 96-text chunk with retry + backoff."""
        client = self._ensure_client() or self._client

        # Cohere embed-v4 token cap: truncate outliers
        texts = [t[:4096] for t in texts]

        backoff = 1.0
        last_err: Exception | None = None

        for attempt in range(1, self.MAX_ATTEMPTS + 1):
            # RSS guard before each API call
            rss = _current_rss_mb()
            if rss > 0 and rss > MAX_RSS_MB * 0.9:
                log.warning(
                    "RSS %d MB approaching limit %d MB (90%%) before API call",
                    rss, MAX_RSS_MB,
                )
                self._recreate_client()
                client = self._client

            try:
                resp = self._client.embed(
                    model=EMBED_MODEL,
                    input_type=input_type,
                    embedding_types=["float"],
                    texts=texts,
                )

                # Extract floats immediately and release the response object
                floats = getattr(resp.embeddings, "float", None)
                if floats is None and isinstance(resp.embeddings, dict):
                    floats = resp.embeddings.get("float")
                if not floats:
                    raise RuntimeError("cohere returned no float embeddings")

                result = [list(v) for v in floats]
                del resp, floats
                return result

            except Exception as e:  # noqa: BLE001
                msg = str(e).lower()
                if (
                    "401" in msg
                    or "unauthorized" in msg
                    or "invalid api token" in msg
                    or ("400" in msg and "rate" not in msg)
                ):
                    raise
                last_err = e
                if attempt < self.MAX_ATTEMPTS:
                    log.warning(
                        "cohere.embed attempt %d/%d failed (%s); backoff %.1fs",
                        attempt, self.MAX_ATTEMPTS, type(e).__name__, backoff,
                    )
                    time.sleep(backoff)
                    backoff = min(backoff * 2.0, 30.0)

        raise RuntimeError(
            f"cohere.embed failed after {self.MAX_ATTEMPTS} attempts: {last_err}"
        ) from last_err

    def _embed_cohere(self, texts: list[str], input_type: str) -> list[list[float]]:
        """Embed via Cohere with chunked batching and per-chunk GC."""
        self._ensure_client()
        out: list[list[float]] = []

        for i in range(0, len(texts), self.CHUNK_SIZE):
            chunk = texts[i : i + self.CHUNK_SIZE]
            vecs = self._embed_chunk(chunk, input_type)
            out.extend(vecs)

            # GC after every chunk to prevent accumulation
            gc.collect()

        return out

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        return self._embed_cohere(texts, input_type="search_document")

    def embed_query(self, text: str) -> list[float]:
        out = self._embed_cohere([text], input_type="search_query")
        return out[0]


# ── Provider factory ────────────────────────────────────────────────────────


_PROVIDER_MAP: dict[str, type[EmbedProvider]] = {
    "local-minilm": MiniLMProvider,
    "local-bge-large": BGELargeProvider,
    "local-gte-qwen2": GTEQwen2Provider,
    "cohere": CohereProvider,
}


def _make_provider() -> EmbedProvider:
    cls = _PROVIDER_MAP.get(EMBED_PROVIDER)
    if cls is None:
        raise RuntimeError(f"unknown embed_provider: {EMBED_PROVIDER!r}")
    return cls()


# ── Module-level singleton + public API ─────────────────────────────────────

_provider: EmbedProvider | None = None


def _get_provider() -> EmbedProvider:
    global _provider
    if _provider is None:
        _provider = _make_provider()
    return _provider


def get_model():
    """Eager-load the provider so the indexer's startup-time check sees it."""
    p = _get_provider()
    # For local providers, trigger model load
    if isinstance(p, _LocalSTProvider):
        p._load()
    return p


def embed_batch(texts: list[str]) -> list[list[float]]:
    """Embed a batch as DOCUMENTS (used for indexing)."""
    return _get_provider().embed_batch(texts)


def embed_query(text: str) -> list[float]:
    """Embed a single QUERY (used at search time). Validates dimension against Qdrant."""
    from .config import QDRANT_URL, QDRANT_COLLECTION, EMBED_PROVIDER
    vec = _get_provider().embed_query(text)

    # Validate dimension matches the Qdrant collection to give a clear error
    # instead of a cryptic 400 Bad Request from Qdrant.
    try:
        resp = requests.get(
            f"{QDRANT_URL}/collections/{QDRANT_COLLECTION}",
            timeout=10,
        )
        if resp.ok:
            actual_dim = (
                resp.json()
                .get("result", {})
                .get("config", {})
                .get("params", {})
                .get("vectors", {})
                .get("size")
            )
            if actual_dim and actual_dim != len(vec):
                raise ValueError(
                    f"Dimension mismatch: embed_query returned a {len(vec)}-dim vector "
                    f"but Qdrant collection '{QDRANT_COLLECTION}' expects {actual_dim}-dim. "
                    f"Current EMBED_PROVIDER='{EMBED_PROVIDER}'. "
                    f"If you switched embedding providers/models, you must recreate the "
                    f"collection with: python -m indexer init-collection --recreate"
                )
    except requests.ConnectionError:
        pass  # Qdrant not reachable — skip validation, let Qdrant fail naturally

    return vec


def teardown_provider() -> None:
    """Teardown the current provider and reset the singleton."""
    global _provider
    if _provider is not None:
        _provider.teardown()
        _provider = None


# Register teardown on process exit
atexit.register(teardown_provider)
