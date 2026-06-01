"""File walker — deny-list mode.

Yields every text file under PROJECT_ROOT except:
- explicitly excluded dirs (build artifacts, caches, vendor, …)
- explicitly excluded files (lockfiles, …)
- explicitly excluded suffixes (binaries, images, fonts, archives, media)
- files larger than MAX_FILE_BYTES
- files that fail a quick null-byte binary sniff
- files that look minified/dumped (line density check)

Language is detected from the suffix; unknown suffixes default to
"text" and go through the line-based fallback chunker.
"""
from __future__ import annotations

import logging
import os
import re as _re
from typing import Iterator, Tuple

from .config import (
    PROJECT_ROOT,
    MAX_FILE_BYTES,
    EXTRA_EXCLUDE_DIR_NAMES,
    EXTRA_EXCLUDE_FILE_PATTERNS,
)

log = logging.getLogger(__name__)


EXCLUDE_DIR_NAMES = {
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".next",
    ".vite",
    ".nuxt",
    "bin",
    "obj",
    ".git",
    ".cache",
    ".turbo",
    "out",
    "tmp",
    "target",        # rust / java
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "venv",
    ".venv",
    ".tox",
    "playwright-report",
    "test-results",
    "wwwroot",
    "TestResults",
    "publish",
    "vendor",
    ".idea",
    ".vs",
    ".vscode",
    "storybook-static",
    "storybook-build",
    ".storybook-cache",
    ".wide-researcher",  # don't index our own sidecar
    "screenshots",         # qa / debug screenshots
    "logs",
    "sessions",
    "pastes",
}
EXCLUDE_DIR_NAMES.update(EXTRA_EXCLUDE_DIR_NAMES)


# Dot-prefixed directories that we DO want to index.
ALLOWED_DOT_DIRS = {".claude", ".github", ".gitlab", ".circleci"}


EXCLUDE_FILES = {
    "repomix-output.xml",
    "package-lock.json",
    "bun.lock",
    "bun.lockb",
    "yarn.lock",
    "pnpm-lock.yaml",
    "Cargo.lock",
    "poetry.lock",
    "Pipfile.lock",
    "uv.lock",
    "composer.lock",
    "Gemfile.lock",
    ".DS_Store",
}


# Pattern-based filename excludes — basename regex.
EXCLUDE_FILE_PATTERNS = [
    _re.compile(r"_dump\.json$"),
    _re.compile(r"-dump\.json$"),
    _re.compile(r"^\d{4}-\d{2}-\d{2}.*\.json$"),
    _re.compile(r"\.export\.json$"),
    _re.compile(r"^execution-\d+.*\.json$"),
    _re.compile(r"^run-\d+.*\.json$"),
    _re.compile(r"^trace-\d+.*\.json$"),
    _re.compile(r"-logs\.json$"),
    # Icon font selection files (large, generated, low semantic value)
    _re.compile(r"^selection\.json$"),
    # .NET post-process coverage / profiling XML dumps
    _re.compile(r"\.pp\.xml$"),
    # tsbuildinfo (generated, huge, no semantic value)
    _re.compile(r"\.tsbuildinfo$"),
    # Backup files (dead code, previous versions)
    _re.compile(r"\.backup\d*$"),
    # Runtime logs/session captures are generated data, not source.
    _re.compile(r"\.log$"),
    _re.compile(r"\.log\.\d+$"),
    _re.compile(r"^session_.*\.json$"),
    _re.compile(r"^request_dump_.*\.json$"),
]
for extra in EXTRA_EXCLUDE_FILE_PATTERNS:
    try:
        EXCLUDE_FILE_PATTERNS.append(_re.compile(extra))
    except _re.error as e:
        log.warning("invalid extra exclude pattern %r: %s — skipping", extra, e)


ALLOWED_DOT_FILES = {
    ".gitignore",
    ".gitattributes",
    ".env.example",
    ".eslintrc",
    ".eslintrc.json",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".prettierrc",
    ".prettierrc.json",
    ".prettierignore",
    ".nvmrc",
    ".dockerignore",
    ".editorconfig",
    ".npmrc",
    ".tool-versions",
}


BINARY_SUFFIXES = {
    # images
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff", ".tif",
    ".psd", ".ai", ".eps", ".svg",
    # fonts
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    # archives
    ".zip", ".gz", ".tar", ".tgz", ".7z", ".rar", ".bz2", ".xz",
    # native binaries
    ".exe", ".dll", ".so", ".dylib", ".a", ".o", ".lib", ".pdb",
    # media
    ".mp4", ".mp3", ".wav", ".ogg", ".webm", ".mov", ".avi", ".mkv", ".flac", ".m4a",
    # docs (binary)
    ".pdf", ".docx", ".xlsx", ".pptx", ".doc", ".xls", ".ppt",
    # databases & dumps
    ".db", ".sqlite", ".sqlite3", ".dump",
    # huge generated maps + minified bundles
    ".map",
    # IDE / project lockish stuff
    ".suo", ".user",
    # 3D model binaries
    ".blend", ".glb", ".gltf", ".fbx", ".obj", ".stl", ".dae",
    # other binaries
    ".class", ".jar", ".war", ".ear", ".bin", ".dat", ".pyc", ".pyo",
}


LANG_BY_SUFFIX = {
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "typescript",
    ".jsx": "tsx",
    ".mjs": "typescript",
    ".cjs": "typescript",
    ".cs": "csharp",
    ".py": "python",
    ".pyi": "python",
    ".go": "go",
    ".rs": "rust",
    ".json": "json",
    ".md": "markdown",
    ".mdx": "markdown",
    ".css": "css",
    ".scss": "css",
    ".sass": "css",
    ".less": "css",
    ".html": "text",
    ".htm": "text",
    ".sql": "text",
    ".yml": "text",
    ".yaml": "text",
    ".toml": "text",
    ".ini": "text",
    ".cfg": "text",
    ".conf": "text",
    ".env": "text",
    ".sh": "text",
    ".bash": "text",
    ".zsh": "text",
    ".ps1": "text",
    ".rb": "text",
    ".java": "text",
    ".kt": "text",
    ".swift": "text",
    ".csproj": "text",
    ".sln": "text",
    ".xml": "text",
    ".txt": "text",
    ".log": "text",
    ".http": "text",
    ".tf": "text",
    ".tfvars": "text",
    ".graphql": "text",
    ".gql": "text",
    ".proto": "text",
    ".prisma": "text",
}


EXACT_FILENAME_LANG = {
    "Dockerfile": "text",
    "Makefile": "text",
    "Procfile": "text",
    ".gitignore": "text",
    ".gitattributes": "text",
    ".env.example": "text",
    ".editorconfig": "text",
    ".nvmrc": "text",
    ".npmrc": "text",
    ".dockerignore": "text",
    ".eslintrc": "text",
    ".prettierrc": "text",
    ".prettierignore": "text",
}


def _is_excluded_dir(name: str) -> bool:
    if name in EXCLUDE_DIR_NAMES:
        return True
    if name.startswith(".") and name not in ALLOWED_DOT_DIRS:
        return True
    return False


def _looks_binary(path: str) -> bool:
    """Cheap sniff: first 8 KB has any null bytes → call it binary."""
    try:
        with open(path, "rb") as f:
            chunk = f.read(8192)
    except OSError:
        return True
    return b"\x00" in chunk


def _looks_minified_or_dump(path: str, size: int) -> bool:
    if size <= 16 * 1024:
        return False
    try:
        with open(path, "rb") as f:
            head = f.read(min(size, 32 * 1024))
    except OSError:
        return False
    newlines = head.count(b"\n")
    if newlines == 0:
        return True
    avg_line = len(head) // (newlines + 1)
    return avg_line > 600


def _pick_language(fn: str) -> str:
    if fn in EXACT_FILENAME_LANG:
        return EXACT_FILENAME_LANG[fn]
    suffix = os.path.splitext(fn)[1].lower()
    if suffix in LANG_BY_SUFFIX:
        return LANG_BY_SUFFIX[suffix]
    return "text"


def iter_files(roots: list[str] | None = None) -> Iterator[Tuple[str, str, str]]:
    """Yield (project, abs_path, language) for every indexable file under roots.

    If `roots` is omitted, defaults to `[PROJECT_ROOT]`.
    """
    if not roots:
        roots = [PROJECT_ROOT]
    project_label = os.path.basename(PROJECT_ROOT.rstrip(os.sep)) or "project"

    for root in roots:
        if not os.path.isdir(root):
            log.warning("skip: root not a dir: %s", root)
            continue
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            dirnames[:] = [d for d in dirnames if not _is_excluded_dir(d)]

            for fn in filenames:
                if fn in EXCLUDE_FILES:
                    continue
                if fn.startswith(".") and fn not in ALLOWED_DOT_FILES:
                    continue
                if fn.endswith(".min.js") or fn.endswith(".min.css"):
                    continue
                if any(pat.search(fn) for pat in EXCLUDE_FILE_PATTERNS):
                    continue

                suffix = os.path.splitext(fn)[1].lower()
                if suffix in BINARY_SUFFIXES:
                    continue

                abs_path = os.path.join(dirpath, fn)
                try:
                    sz = os.path.getsize(abs_path)
                except OSError as e:
                    log.warning("stat failed %s: %s", abs_path, e)
                    continue
                if sz > MAX_FILE_BYTES:
                    log.info("skip large file (%d bytes): %s", sz, abs_path)
                    continue
                if sz == 0:
                    continue
                if _looks_binary(abs_path):
                    log.info("skip binary (null bytes detected): %s", abs_path)
                    continue
                if _looks_minified_or_dump(abs_path, sz):
                    log.info("skip minified/dump (low line density): %s", abs_path)
                    continue
                yield project_label, abs_path, _pick_language(fn)
