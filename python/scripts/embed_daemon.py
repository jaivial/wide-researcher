#!/usr/bin/env python3
"""wide-researcher · shared embedding + rerank daemon.

ONE process, ONE model copy, shared by every MCP session, the indexer,
the watcher and bulk-reindex. Listens on a unix-domain socket and speaks
the same newline-delimited JSON protocol the old per-session
`embed_worker.py` used, so callers are thin clients that hold no model.

## Why this exists

`sentence-transformers` + PyTorch leak intermediate buffers (~5-15 MB
per batch). Previously each MCP session and each `indexer file`
subprocess loaded its own resident model, so N concurrent sessions =
N model copies + N leaks → the host OOMs. Centralising the model here
caps RAM at 1x model regardless of session count, and the RSS-watchdog
recycles the model in-place when it drifts past the ceiling, so the
leak can never accumulate without bound.

## Protocol (one JSON object per line, one response per line)

  {"op":"embed","text":"..."}             -> {"ok":true,"vec":[...]}
  {"op":"embed_batch","texts":[...]}       -> {"ok":true,"vecs":[[...]]}
  {"op":"rerank","query":"...",            -> {"ok":true,"scores":[...]}
    "docs":["...","..."]}
  {"op":"ping"}                            -> {"ok":true,"pong":true}

Errors: {"ok":false,"err":"..."}

## Config (env)

  WR_EMBED_SOCKET   unix socket path   (default /root/.wide-researcher/embed.sock)
  WR_EMBED_MODEL    embed model id     (default BAAI/bge-m3)
  WR_RERANK_MODEL   cross-encoder id   (default BAAI/bge-reranker-v2-m3)
  WR_EMBED_BATCH    encode batch size  (default 16)
  WR_EMBED_THREADS  torch threads      (default 4)
  WR_MAX_RSS_MB     RSS ceiling MB     (default 0 = 70% of system RAM)
  WR_DISABLE_RERANK "1" -> rerank returns flat 1.0 scores
"""
from __future__ import annotations

import gc
import json
import logging
import os
import socket
import sys
import threading

# Cap math-lib threads BEFORE numpy/torch import.
_THREADS = os.environ.get("WR_EMBED_THREADS", "4")
for _v in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "ORT_NUM_THREADS"):
    os.environ.setdefault(_v, _THREADS)

log = logging.getLogger("wide-researcher.embed-daemon")

SOCKET_PATH = os.environ.get("WR_EMBED_SOCKET", "/root/.wide-researcher/embed.sock")
EMBED_MODEL = os.environ.get("WR_EMBED_MODEL", "BAAI/bge-base-en-v1.5")
RERANK_MODEL = os.environ.get("WR_RERANK_MODEL", "cross-encoder/ms-marco-MiniLM-L-6-v2")
EMBED_BATCH = int(os.environ.get("WR_EMBED_BATCH", "16"))
DISABLE_RERANK = os.environ.get("WR_DISABLE_RERANK", "") == "1"
MAX_TEXT_CHARS = 8000  # ~2000 tokens; chunks are <=4800 chars, this is a guard


def _detect_max_rss_mb() -> int:
    env = int(os.environ.get("WR_MAX_RSS_MB", "0"))
    if env > 0:
        return env
    try:
        with open("/proc/meminfo", encoding="utf-8") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    return int(int(line.split()[1]) / 1024 * 0.70)
    except Exception:
        pass
    return 4096


MAX_RSS_MB = _detect_max_rss_mb()


def _current_rss_mb() -> int:
    try:
        with open("/proc/self/status", encoding="utf-8") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) // 1024
    except Exception:
        pass
    return 0


class _Models:
    """Lazy model holder with in-place recycle to defeat the torch leak."""

    def __init__(self) -> None:
        self._embed = None
        self._rerank = None
        self._lock = threading.Lock()
        import torch
        try:
            torch.set_num_threads(int(_THREADS))
            torch.set_num_interop_threads(1)
        except (RuntimeError, ValueError):
            pass

    def _load_embed(self):
        if self._embed is None:
            log.info("loading embed model: %s", EMBED_MODEL)
            from sentence_transformers import SentenceTransformer
            self._embed = SentenceTransformer(EMBED_MODEL, device="cpu")
        return self._embed

    def _load_rerank(self):
        if self._rerank is None:
            log.info("loading rerank model: %s", RERANK_MODEL)
            from sentence_transformers import CrossEncoder
            self._rerank = CrossEncoder(RERANK_MODEL, device="cpu")
        return self._rerank

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        texts = [t[:MAX_TEXT_CHARS] for t in texts]
        with self._lock:
            m = self._load_embed()
            vecs = m.encode(
                texts,
                batch_size=EMBED_BATCH,
                normalize_embeddings=True,
                show_progress_bar=False,
                convert_to_numpy=True,
            )
            out = [v.tolist() for v in vecs]
        self._maybe_recycle()
        return out

    def rerank(self, query: str, docs: list[str]) -> list[float]:
        if not docs:
            return []
        if DISABLE_RERANK:
            return [1.0] * len(docs)
        pairs = [[query[:MAX_TEXT_CHARS], (d or "")[:MAX_TEXT_CHARS]] for d in docs]
        with self._lock:
            m = self._load_rerank()
            scores = m.predict(pairs, batch_size=EMBED_BATCH, show_progress_bar=False)
            out = [float(s) for s in scores]
        self._maybe_recycle()
        return out

    def _maybe_recycle(self) -> None:
        rss = _current_rss_mb()
        if rss and rss > MAX_RSS_MB:
            log.warning("RSS %d MB > ceiling %d MB — recycling models", rss, MAX_RSS_MB)
            with self._lock:
                self._embed = None
                self._rerank = None
                gc.collect()
            try:
                import torch
                if hasattr(torch, "cuda") and torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass


def _handle_request(models: _Models, req: dict) -> dict:
    op = req.get("op", "embed")
    if op == "ping":
        return {"ok": True, "pong": True}
    if op == "embed":
        vec = models.embed([req.get("text", "")])
        return {"ok": True, "vec": vec[0] if vec else []}
    if op == "embed_batch":
        return {"ok": True, "vecs": models.embed(list(req.get("texts", [])))}
    if op == "rerank":
        scores = models.rerank(req.get("query", ""), list(req.get("docs", [])))
        return {"ok": True, "scores": scores}
    return {"ok": False, "err": f"unknown op: {op!r}"}


def _serve_conn(models: _Models, conn: socket.socket) -> None:
    with conn, conn.makefile("r", encoding="utf-8") as rf, conn.makefile("w", encoding="utf-8") as wf:
        for line in rf:
            line = line.rstrip("\n")
            if not line:
                continue
            try:
                req = json.loads(line)
                resp = _handle_request(models, req)
            except json.JSONDecodeError as e:
                resp = {"ok": False, "err": f"bad json: {e}"}
            except Exception as e:  # noqa: BLE001
                log.exception("request failed")
                resp = {"ok": False, "err": str(e)}
            try:
                wf.write(json.dumps(resp) + "\n")
                wf.flush()
            except (BrokenPipeError, ConnectionResetError):
                return


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    log.info(
        "embed-daemon starting · socket=%s embed=%s rerank=%s threads=%s max_rss=%dMB rerank_disabled=%s",
        SOCKET_PATH, EMBED_MODEL, RERANK_MODEL, _THREADS, MAX_RSS_MB, DISABLE_RERANK,
    )

    os.makedirs(os.path.dirname(SOCKET_PATH) or ".", exist_ok=True)
    if os.path.exists(SOCKET_PATH):
        os.unlink(SOCKET_PATH)

    models = _Models()

    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(SOCKET_PATH)
    os.chmod(SOCKET_PATH, 0o600)
    srv.listen(64)
    log.info("listening on %s", SOCKET_PATH)

    try:
        while True:
            conn, _ = srv.accept()
            t = threading.Thread(target=_serve_conn, args=(models, conn), daemon=True)
            t.start()
    except KeyboardInterrupt:
        pass
    finally:
        srv.close()
        try:
            os.unlink(SOCKET_PATH)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
