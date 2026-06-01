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

# Provider selection (v0.1.0-alpha.3+):
#   "local-minilm"       → sentence-transformers/all-MiniLM-L6-v2 on disk (384-d)
#   "local-bge-large"    → BAAI/bge-large-en-v1.5 on disk (1024-d)
#   "local-gte-qwen2"    → Alibaba-NLP/gte-Qwen2-1.5B-instruct on disk (1536-d)
#   "cohere"             → Cohere embed-v4.0 cloud API (1536-d)
# Legacy configs without `embed_provider` default to local-minilm.
EMBED_PROVIDER: str = str(_cfg.get("embed_provider", "local-minilm"))

# For local models: resolves to a filesystem path under
# ~/.wide-researcher/models/. For cohere: the model id "embed-v4.0".
EMBED_MODEL: str = str(
    _cfg.get("model_path")
    or _cfg.get("embed_model")
    or "sentence-transformers/all-MiniLM-L6-v2"
)
EMBED_DIM: int = int(_cfg.get("embed_dim", 384))
BATCH_SIZE: int = int(_cfg.get("batch_size", 16))
MAX_FILE_BYTES: int = int(_cfg.get("max_file_bytes", 50 * 1024 * 1024))

# Cohere-only: where to read the API key from.
SECRETS_PATH: str = str(_cfg.get("secrets_path", ""))
COHERE_API_KEY_FIELD: str = str(_cfg.get("cohere_api_key_field", "cohere_api_key"))

# Optional exact graph backend. Qdrant remains the default.
GRAPH_PROVIDER: str = str(_cfg.get("graph_provider", "qdrant"))
_NEO4J_CFG = _cfg.get("neo4j", {}) if isinstance(_cfg.get("neo4j", {}), dict) else {}
NEO4J_URI_ENV: str = str(_NEO4J_CFG.get("uri_env", "NEO4J_URI"))
NEO4J_USER_ENV: str = str(_NEO4J_CFG.get("user_env", "NEO4J_USERNAME"))
NEO4J_PASSWORD_ENV: str = str(_NEO4J_CFG.get("password_env", "NEO4J_PASSWORD"))
NEO4J_DATABASE_ENV: str = str(_NEO4J_CFG.get("database_env", "NEO4J_DATABASE"))


def _load_cohere_key() -> str:
    """Read the Cohere API key from the secrets file at runtime. Never log it."""
    if not SECRETS_PATH:
        raise RuntimeError(
            "embed_provider=cohere but secrets_path is empty in project config. "
            "Re-run `wide-researcher init` to wire the key."
        )
    try:
        with open(SECRETS_PATH, encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        raise RuntimeError(f"failed to read secrets at {SECRETS_PATH}: {e}") from e
    key = doc.get(COHERE_API_KEY_FIELD)
    if not isinstance(key, str) or len(key) < 20:
        raise RuntimeError(
            f"Cohere API key missing or too short in {SECRETS_PATH} "
            f"(field={COHERE_API_KEY_FIELD!r}). Re-run `wide-researcher init`."
        )
    return key

# Memory guards (v0.1.0-alpha.8+):
#   max_rss_mb — RSS ceiling in MB. 0 = auto-detect (80% of system RAM).
#   chunk_cap  — max chunks emitted per file. Prevents OOM on dense files.
MAX_RSS_MB: int = int(_cfg.get("max_rss_mb", 0))
CHUNK_CAP: int = int(_cfg.get("chunk_cap", 500))


def _cgroup_file_candidates(filename: str) -> list[Path]:
    candidates: list[Path] = []
    try:
        for line in Path("/proc/self/cgroup").read_text(encoding="utf-8").splitlines():
            parts = line.split(":")
            if len(parts) != 3:
                continue
            hierarchy, controllers, rel_path = parts
            rel = rel_path.lstrip("/")
            if hierarchy == "0":
                candidates.append(Path("/sys/fs/cgroup") / rel / filename)
            elif "memory" in controllers.split(","):
                candidates.append(Path("/sys/fs/cgroup/memory") / rel / filename)
    except OSError:
        pass
    candidates.append(Path("/sys/fs/cgroup") / filename)
    candidates.append(Path("/sys/fs/cgroup/memory") / filename)
    return candidates


def _read_cgroup_memory_limit_mb() -> int | None:
    """Return the cgroup memory ceiling in MB when the process has one."""
    candidates = _cgroup_file_candidates("memory.max") + _cgroup_file_candidates(
        "memory.limit_in_bytes"
    )
    for path in candidates:
        try:
            raw = path.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if not raw or raw == "max":
            continue
        try:
            limit_bytes = int(raw)
        except ValueError:
            continue
        # Some cgroup v1 hosts report a sentinel that is larger than real RAM.
        if limit_bytes <= 0 or limit_bytes >= 1 << 60:
            continue
        return limit_bytes // (1024 * 1024)
    return None


def _detect_max_rss_mb() -> int:
    """Auto-detect: 80% of the effective memory ceiling."""
    physical_mb: int | None = None
    try:
        with open("/proc/meminfo", encoding="utf-8") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    total_kb = int(line.split()[1])
                    physical_mb = int(total_kb / 1024)
                    break
    except Exception:
        pass

    cgroup_mb = _read_cgroup_memory_limit_mb()
    limits = [v for v in (physical_mb, cgroup_mb) if v and v > 0]
    if limits:
        return int(min(limits) * 0.8)

    try:
        import psutil  # type: ignore[import-not-found]
        return int(psutil.virtual_memory().total / (1024 * 1024) * 0.8)
    except Exception:
        return 2048  # safe fallback: 2 GB


if MAX_RSS_MB <= 0:
    MAX_RSS_MB = _detect_max_rss_mb()

# extra exclude lists (extend the defaults baked into walk.py)
EXTRA_EXCLUDE_DIR_NAMES: list[str] = list(_cfg.get("exclude_dir_names", []))
EXTRA_EXCLUDE_FILE_PATTERNS: list[str] = list(_cfg.get("exclude_file_patterns", []))

# sidecar file→hash index lives alongside the project config by default.
# BUG fix (v0.1.0-alpha.5): Path("") evaluates to PosixPath('.') which
# is truthy — the old `or` chain therefore picked "." as FILE_INDEX_PATH,
# leading to `os.replace('..tmp', '.')` and EBUSY on every upsert.
_file_index_cfg = (_cfg.get("file_index_path") or "").strip()
if _file_index_cfg:
    FILE_INDEX_PATH: str = str(Path(_file_index_cfg).expanduser())
else:
    FILE_INDEX_PATH = str(Path(PROJECT_ROOT) / ".wide-researcher" / ".file_index.json")


def get_conn():
    """Legacy shim; Qdrant-backed db.py ignores it."""
    return None
