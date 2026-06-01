"""Thin client for the shared embed daemon (scripts/embed_daemon.py).

Callers (the MCP embed_worker, the indexer, the watcher) talk to ONE
long-lived daemon over a unix socket instead of loading a model each.
This keeps every consumer process model-free so RAM stays bounded.
"""
from __future__ import annotations

import json
import os
import socket
import threading
import time

DEFAULT_SOCKET = os.environ.get("WR_EMBED_SOCKET", "/root/.wide-researcher/embed.sock")


class DaemonError(RuntimeError):
    pass


class DaemonClient:
    """Reconnecting, thread-safe line-JSON client for the embed daemon."""

    def __init__(self, socket_path: str | None = None, connect_timeout: float = 30.0):
        self._path = socket_path or DEFAULT_SOCKET
        self._connect_timeout = connect_timeout
        self._sock: socket.socket | None = None
        self._rf = None
        self._wf = None
        self._lock = threading.Lock()

    def _connect(self) -> None:
        deadline = time.time() + self._connect_timeout
        backoff = 0.2
        last: Exception | None = None
        while time.time() < deadline:
            try:
                s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                s.connect(self._path)
                self._sock = s
                self._rf = s.makefile("r", encoding="utf-8")
                self._wf = s.makefile("w", encoding="utf-8")
                return
            except (FileNotFoundError, ConnectionRefusedError, OSError) as e:
                last = e
                time.sleep(backoff)
                backoff = min(backoff * 1.6, 2.0)
        raise DaemonError(f"embed daemon unreachable at {self._path}: {last}")

    def _close(self) -> None:
        for h in (self._rf, self._wf, self._sock):
            try:
                if h is not None:
                    h.close()
            except OSError:
                pass
        self._sock = self._rf = self._wf = None

    def request(self, obj: dict) -> dict:
        line = json.dumps(obj)
        with self._lock:
            for attempt in range(2):  # one reconnect retry
                try:
                    if self._sock is None:
                        self._connect()
                    assert self._wf is not None and self._rf is not None
                    self._wf.write(line + "\n")
                    self._wf.flush()
                    resp = self._rf.readline()
                    if not resp:
                        raise DaemonError("daemon closed connection")
                    return json.loads(resp)
                except (OSError, DaemonError, ValueError) as e:
                    self._close()
                    if attempt == 1:
                        raise DaemonError(f"embed daemon request failed: {e}") from e
            raise DaemonError("unreachable")  # pragma: no cover

    def embed_query(self, text: str) -> list[float]:
        r = self.request({"op": "embed", "text": text})
        if not r.get("ok"):
            raise DaemonError(r.get("err", "embed failed"))
        return list(r.get("vec", []))

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        r = self.request({"op": "embed_batch", "texts": texts})
        if not r.get("ok"):
            raise DaemonError(r.get("err", "embed_batch failed"))
        return [list(v) for v in r.get("vecs", [])]

    def rerank(self, query: str, docs: list[str]) -> list[float]:
        if not docs:
            return []
        r = self.request({"op": "rerank", "query": query, "docs": docs})
        if not r.get("ok"):
            raise DaemonError(r.get("err", "rerank failed"))
        return [float(s) for s in r.get("scores", [])]
