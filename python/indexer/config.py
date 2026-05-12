"""Config loader for the wide-researcher indexer.

Reads project-specific settings from the JSON file pointed at by the
`WIDE_RESEARCHER_PROJECT_CONFIG` environment variable (typically
`<project>/.wide-researcher/config.json`). All other modules import the
module-level globals defined below; they never read disk themselves.

Project config schema (v0.1):

  {
    "project_name": "myapp",                       # cosmetic
    "project_root": "/abs/path/to/project",        # required
    "collection_name": "myapp_a1b2c3d4",           # required — unique
    "qdrant_url": "http://127.0.0.1:6333",         # optional
    "model_path": "/abs/path/to/all-MiniLM-L6-v2", # optional
    "embed_model": "sentence-transformers/all-MiniLM-L6-v2",  # fallback
    "embed_dim": 384,                              # optional
    "batch_size": 16,                              # optional
    "exclude_dir_names": [...],                    # optional, extends defaults
    "exclude_file_patterns": [...],                # optional, extends defaults
    "max_file_bytes": 65536,                       # optional
    "file_index_path": "/abs/path/.file_index.json"  # optional
  }
"""
from __future__ import annotations

import json
import os
from pathlib import Path

# Cap intra-op threads BEFORE numpy/torch imports anywhere downstream.
# Without this PyTorch/sentence-transformers pegs every available core and
# OOMs the host on big repos.
os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("ORT_NUM_THREADS", "4")
os.environ.setdefault("MKL_NUM_THREADS", "4")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "4")


_CONFIG_ENV_VAR = "WIDE_RESEARCHER_PROJECT_CONFIG"


class ConfigError(RuntimeError):
    pass


def _load_config_dict() -> dict:
    cfg_path = os.environ.get(_CONFIG_ENV_VAR)
    if not cfg_path:
        raise ConfigError(
            f"environment variable {_CONFIG_ENV_VAR} is not set. "
            "Point it at your project's .wide-researcher/config.json"
        )
    p = Path(cfg_path)
    if not p.is_file():
        raise ConfigError(f"config file not found: {cfg_path}")
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ConfigError(f"config file is not valid JSON: {cfg_path}: {e}") from e


_cfg = _load_config_dict()


def _require(key: str):
    if key not in _cfg or _cfg[key] in ("", None):
        raise ConfigError(f"required config key missing: {key}")
    return _cfg[key]


# ── required ──────────────────────────────────────────────────────────────────
PROJECT_NAME: str = str(_cfg.get("project_name", "project"))
PROJECT_ROOT: str = str(_require("project_root"))
QDRANT_COLLECTION: str = str(_require("collection_name"))

# ── optional ──────────────────────────────────────────────────────────────────
QDRANT_URL: str = str(_cfg.get("qdrant_url", "http://127.0.0.1:6333"))
EMBED_MODEL: str = str(
    _cfg.get("model_path")
    or _cfg.get("embed_model")
    or "sentence-transformers/all-MiniLM-L6-v2"
)
EMBED_DIM: int = int(_cfg.get("embed_dim", 384))
BATCH_SIZE: int = int(_cfg.get("batch_size", 16))
MAX_FILE_BYTES: int = int(_cfg.get("max_file_bytes", 64 * 1024))

# extra exclude lists (extend the defaults baked into walk.py)
EXTRA_EXCLUDE_DIR_NAMES: list[str] = list(_cfg.get("exclude_dir_names", []))
EXTRA_EXCLUDE_FILE_PATTERNS: list[str] = list(_cfg.get("exclude_file_patterns", []))

# sidecar file→hash index lives alongside the project config by default
_default_sidecar = str(
    Path(_cfg.get("file_index_path", "")).expanduser()
    or Path(PROJECT_ROOT) / ".wide-researcher" / ".file_index.json"
)
FILE_INDEX_PATH: str = _default_sidecar


def get_conn():
    """Legacy shim; Qdrant-backed db.py ignores it."""
    return None
