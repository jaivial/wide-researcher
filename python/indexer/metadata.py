"""Derive per-file metadata from path conventions.

Generic version — works on any project. Atomic-design / agent-owner
heuristics (atoms / hooks / pages / stories) still apply if the
project follows the React-atomic convention; otherwise they cleanly
fall through to language-based defaults.

The output dict is flattened into the Qdrant payload by db.py so the
fields can be queried server-side.
"""
from __future__ import annotations

import os

# Common atomic-design / monorepo layer names. If a path part matches
# one of these, we record it on the chunk so downstream consumers can
# filter ("show me hits in `atoms/` only").
ATOMIC_LAYERS = (
    "atoms", "ui", "hooks", "helpers", "components",
    "pages", "layouts", "api", "signalr", "locales",
    "stories", "types", "constants", "__tests__",
    "services", "models", "controllers", "routes",
    "middleware", "lib", "utils",
)


def _detect_atomic_layer(abs_path: str) -> str | None:
    parts = abs_path.split(os.sep)
    for layer in ATOMIC_LAYERS:
        if layer in parts:
            return layer
    fn = os.path.basename(abs_path)
    if fn == "types.ts":
        return "types"
    if fn == "constants.ts":
        return "constants"
    return None


def _is_backend_path(abs_path: str) -> bool:
    parts = {p.lower() for p in abs_path.split(os.sep)}
    backend_parts = {
        "server", "mcp-server", "api", "routes", "controllers", "middleware",
        "services", "models", "bin", "cli", "workers", "signalr",
    }
    return bool(parts & backend_parts)


def _detect_runtime(abs_path: str, language: str) -> str:
    if language == "markdown":
        return "docs"
    if language == "csharp":
        return "dotnet"
    if language == "python":
        return "python"
    if language in ("go", "rust"):
        return "native"
    if language in ("typescript", "tsx", "javascript", "jsx"):
        if _is_backend_path(abs_path) or abs_path.endswith(".config.ts"):
            return "node"
        if language in ("tsx", "jsx"):
            return "browser"
        parts = {p.lower() for p in abs_path.split(os.sep)}
        if parts & {"components", "pages", "hooks", "atoms", "ui", "layouts"}:
            return "browser"
        return "node"
    return "unknown"


def _detect_role(abs_path: str, language: str) -> str:
    """Best-effort role tag (frontend / backend / docs / tests / config)."""
    fn = os.path.basename(abs_path)
    parts = abs_path.split(os.sep)

    if fn.endswith(".stories.tsx") or fn.endswith(".stories.ts"):
        return "stories"
    if any(fn.endswith(suf) for suf in (".spec.ts", ".test.ts", ".spec.tsx", ".test.tsx",
                                          "_test.go", "_test.py", "_spec.rb")):
        return "tests"
    if "__tests__" in parts or "tests" in parts:
        return "tests"
    if language == "markdown":
        return "docs"
    if language in ("json", "text") and fn in (
        "package.json", "tsconfig.json", "Cargo.toml", "pyproject.toml",
        "go.mod", "Gemfile", "Dockerfile",
    ):
        return "config"
    runtime = _detect_runtime(abs_path, language)
    if runtime == "browser" or language == "css":
        return "frontend"
    if runtime in ("node", "dotnet", "python", "native") or language in ("csharp", "python", "go", "rust"):
        return "backend"
    return "other"


_TEST_SUFFIXES = (".spec.ts", ".test.ts", ".test.tsx", ".spec.tsx",
                   "_test.go", "_test.py", "_spec.rb")


def _is_test(abs_path: str) -> bool:
    fn = os.path.basename(abs_path)
    if any(fn.endswith(s) for s in _TEST_SUFFIXES):
        return True
    if "/__tests__/" in abs_path or "/tests/" in abs_path or "/test/" in abs_path:
        return True
    return False


def _is_story(abs_path: str) -> bool:
    return abs_path.endswith(".stories.tsx") or abs_path.endswith(".stories.ts")


def _route_owner(abs_path: str) -> str | None:
    if "/src/pages/" in abs_path or "/app/" in abs_path:
        fn = os.path.basename(abs_path)
        base = os.path.splitext(fn)[0].lower()
        return base or None
    return None


def derive_metadata(abs_path: str, repo: str, language: str) -> dict:
    return {
        "atomic_layer": _detect_atomic_layer(abs_path),
        "role": _detect_role(abs_path, language),
        "runtime": _detect_runtime(abs_path, language),
        "is_test": _is_test(abs_path),
        "is_story": _is_story(abs_path),
        "route_owner": _route_owner(abs_path),
        "language": language,
    }
