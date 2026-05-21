#!/usr/bin/env python3
"""wide-researcher · UserPromptSubmit hook (cross-platform).

Reads the prompt JSON Claude Code passes on stdin, runs
`scripts.wide_research` for that prompt, emits a system-reminder
block on stdout that Claude Code injects into model context.

Skips:
  - prompts shorter than 24 chars (likely status checks / one-liners)
  - if qdrant is unreachable
  - if a previous run for the same prompt hash fired <30s ago (debounce)

This file is rendered into `<project>/.wide-researcher/hooks/`
by `installClaudeBundle()` with these placeholders:
  {{VENV_PYTHON}}   — absolute path to ~/.wide-researcher/venv python
  {{PY_ROOT}}       — absolute path to bundled python/ tree
  {{PROJECT_CONFIG}}— absolute path to <project>/.wide-researcher/config.json
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import time
import tempfile
from pathlib import Path
from urllib.request import urlopen
from urllib.error import URLError

PROJECT_CONFIG = r"{{PROJECT_CONFIG}}"
VENV_PYTHON = r"{{VENV_PYTHON}}"
PY_ROOT = r"{{PY_ROOT}}"

# Per-project hook state dir — works on Windows + POSIX.
STATE_BASE = Path(tempfile.gettempdir()) / "wide-researcher-prompt-hook"
STATE_BASE.mkdir(parents=True, exist_ok=True)


def _read_prompt() -> str:
    """Claude Code passes hook payload as JSON on stdin."""
    try:
        raw = sys.stdin.read()
    except Exception:
        raw = ""
    if not raw:
        return sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        d = json.loads(raw)
    except Exception:
        return raw.strip()
    for k in ("prompt", "user_prompt", "userPrompt", "message", "text", "content"):
        v = d.get(k)
        if isinstance(v, str):
            return v
    return ""


def _load_qdrant_url() -> str:
    try:
        cfg = json.loads(Path(PROJECT_CONFIG).read_text(encoding="utf-8"))
    except Exception:
        return "http://127.0.0.1:6333"
    return str(cfg.get("qdrant_url") or "http://127.0.0.1:6333")


def _qdrant_healthy(url: str) -> bool:
    try:
        with urlopen(f"{url}/healthz", timeout=1.0) as r:
            return r.status == 200
    except (URLError, TimeoutError, ConnectionError, OSError):
        return False


def _debounce(prompt: str) -> bool:
    """Return True if we should run; False if a same-prompt run fired <30s ago."""
    h = hashlib.sha1(prompt.encode("utf-8")).hexdigest()[:12]
    last_file = STATE_BASE / f".last-{h}"
    now = int(time.time())
    if last_file.is_file():
        try:
            last = int(last_file.read_text())
            if now - last < 30:
                return False
        except ValueError:
            pass
    last_file.write_text(str(now))
    return True


def main() -> int:
    prompt = _read_prompt()
    if not prompt or len(prompt) < 24:
        return 0

    url = _load_qdrant_url()
    if not _qdrant_healthy(url):
        return 0

    if not _debounce(prompt):
        return 0

    prompt_hash = hashlib.sha1(prompt.encode("utf-8")).hexdigest()[:12]
    slug = f"prompt-{prompt_hash}-{int(time.time())}"
    state_dir = STATE_BASE / slug
    state_dir.mkdir(parents=True, exist_ok=True)

    env = dict(os.environ)
    env["WIDE_RESEARCHER_PROJECT_CONFIG"] = PROJECT_CONFIG

    try:
        proc = subprocess.run(
            [
                VENV_PYTHON,
                "-m",
                "scripts.wide_research",
                "--prompt", prompt,
                "--state-dir", str(state_dir),
                "--top-k", "12",
                "--quiet",
            ],
            cwd=PY_ROOT,
            env=env,
            capture_output=True,
            timeout=25,
            text=True,
        )
    except subprocess.TimeoutExpired:
        return 0
    except FileNotFoundError:
        return 0

    summary = (proc.stdout or "").strip().splitlines()
    last_line = summary[-1] if summary else ""
    if not last_line:
        return 0

    # Emit context injection: short prose + structured impact JSON + binding
    # rule that forbids raw grep on source files (the whole point of the index).
    sys.stdout.write(
        "<wide-research>\n"
        "This project auto-runs wide-research on every user prompt — the\n"
        "impact-radius JSON below was computed against the local Qdrant\n"
        "code index. Graph-aware MCP tools can also query AST/symbol nodes,\n"
        "callers, importers, exports, and type relations.\n\n"
        f"{last_line}\n"
        "</wide-research>\n"
        "\n"
        "<MCP-MANDATORY-FOR-CODE-SEARCH>\n"
        "RULE: For ANY query about CODE content (function bodies, symbol\n"
        "locations, \"where is X\", \"what calls Y\", \"who imports Z\",\n"
        "\"find files that do Z\", impact of a change, or any semantic\n"
        "search over source files), your FIRST tool call MUST be one of\n"
        "these wide-researcher MCP tools — NEVER raw grep / find / Grep /\n"
        "Glob / Bash search:\n"
        "\n"
        "  • mcp__wide-researcher__wr_arch_impact(description)\n"
        "    Entry point for scope/impact. Combines semantic code chunks,\n"
        "    AST/symbol nodes, callers, importers, exports, and type users.\n"
        "\n"
        "  • mcp__wide-researcher__wr_symbol_find(query)\n"
        "    Find declarations: functions, classes, interfaces, components,\n"
        "    C# methods/types. Use for \"where is symbol X defined?\".\n"
        "\n"
        "  • mcp__wide-researcher__wr_callers(symbol)\n"
        "    Find chunks/files that call or reference a symbol. Use for\n"
        "    \"what calls X?\" and blast-radius checks.\n"
        "\n"
        "  • mcp__wide-researcher__wr_importers(pathOrModule)\n"
        "    Find files importing a path or module. Use for dependency impact.\n"
        "\n"
        "  • mcp__wide-researcher__wr_find(query, mode=\"hybrid\")\n"
        "    Chunk-level semantic + keyword + hybrid search. Use for drill-downs.\n"
        "\n"
        "  • mcp__wide-researcher__wr_file(path)\n"
        "    Every chunk of one file, ordered. Use after search/impact tools\n"
        "    locate the right file and you need full content.\n"
        "\n"
        "Bash / Grep / Glob / find are RESERVED for: git ops, file metadata\n"
        "(size, mtime), config inspection (package.json, tsconfig, .env),\n"
        "log scans, system probes. NEVER for searching .ts / .tsx / .cs /\n"
        ".py / .go / .rs / .java / .kt source content.\n"
        "\n"
        "The local Qdrant index is hybrid semantic+keyword plus AST/symbol\n"
        "graph payloads. Raw grep misses semantic and structural hits.\n"
        "Use the MCP.\n"
        "\n"
        "If a deferred-tool error appears, call ToolSearch with\n"
        "  query=\"select:mcp__wide-researcher__wr_arch_impact,\"\n"
        "        \"mcp__wide-researcher__wr_symbol_find,\"\n"
        "        \"mcp__wide-researcher__wr_callers,\"\n"
        "        \"mcp__wide-researcher__wr_importers,\"\n"
        "        \"mcp__wide-researcher__wr_find,\"\n"
        "        \"mcp__wide-researcher__wr_file\"\n"
        "first, then proceed.\n"
        "</MCP-MANDATORY-FOR-CODE-SEARCH>\n"
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # Hook never crashes the prompt — fail silent.
        sys.exit(0)
