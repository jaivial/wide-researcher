"""MCP response interpreter worker — condenses tool results via LLM.

Stdin/stdout JSON worker (same pattern as embed_worker.py). Accepts raw
tool output and returns a concise AI interpretation so LLM clients don't
choke on oversized MCP responses.

Protocol (one JSON object per line, one response per line):

  {"op":"interpret","tool":"wr_find","query":"...","result":{...}}
    -> {"ok":true,"interpretation":"...","tokens_in":N,"tokens_out":N}
  {"op":"ping"}  -> {"ok":true,"pong":true}

Configuration (env, all optional):

  WR_LLM_BASE_URL     Anthropic-compatible endpoint (e.g. https://api.minimax.io/anthropic/v1)
  WR_LLM_API_KEY      API key (default: empty → heuristic fallback)
  WR_LLM_MODEL        Model name (default: "MiniMax-M2.7-highspeed")
  WR_LLM_TIMEOUT      Request timeout seconds (default: 30)
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any

_HERE = os.path.dirname(os.path.abspath(__file__))
_PY_ROOT = os.path.dirname(_HERE)
if _PY_ROOT not in sys.path:
    sys.path.insert(0, _PY_ROOT)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

LLM_BASE_URL = os.environ.get("WR_LLM_BASE_URL") or "https://api.minimax.io/anthropic/v1"
LLM_API_KEY = os.environ.get("WR_LLM_API_KEY") or "no-key"
LLM_MODEL = os.environ.get("WR_LLM_MODEL", "MiniMax-M2.7-highspeed")
LLM_TIMEOUT = int(os.environ.get("WR_LLM_TIMEOUT", "30"))
LLM_API_KEY_HEADER = os.environ.get("WR_LLM_API_KEY_HEADER", "x-api-key")  # "api-key" for OpenAI, "x-api-key" for MiniMax
DISABLE_INTERPRETER = os.environ.get("WIDE_RESEARCHER_DISABLE_INTERPRETER", "") == "1"

# ---------------------------------------------------------------------------
# Tool-specific system prompts (instruct the LLM what to condense)
# ---------------------------------------------------------------------------

SYSTEM_PROMPTS: dict[str, str] = {
    "wr_find": (
        "You are a code-search result summariser. The user searched a codebase "
        "with a query and got back ranked chunks. Summarise the results concisely:\n"
        "1. What the search found overall (key files, symbols, and their relevance)\n"
        "2. The most relevant files and why\n"
        "3. Any patterns or relationships worth noting\n\n"
        "Keep it under 200 words. Focus on actionable insight. Omit raw scores, "
        "line numbers, and preview text unless they are critical."
    ),
    "wr_file": (
        "You are a code reviewer. The user fetched all indexed chunks of a single "
        "file. Summarise:\n"
        "1. What the file does (its purpose based on its content)\n"
        "2. Key symbols defined (classes, functions, types)\n"
        "3. Notable imports and dependencies\n\n"
        "Keep it under 150 words. Be specific about what exists in the file."
    ),
    "wr_impact": (
        "You are an impact-analysis summariser. Given a proposed change and a list "
        "of files likely affected, summarise:\n"
        "1. Which files are most affected and why\n"
        "2. What the files do and how they relate to the change\n"
        "3. Any cross-cutting concerns\n\n"
        "Keep it under 200 words. Focus on the change's impact radius."
    ),
    "wr_symbol_find": (
        "You are a symbol-search summariser. The user searched for symbols in a "
        "codebase. Summarise:\n"
        "1. What symbols were found and their kinds (function, class, interface, etc.)\n"
        "2. Where they are defined\n"
        "3. Their relationships to each other\n\n"
        "Keep it under 150 words."
    ),
    "wr_callers": (
        "You are a call-graph analyser. Given a symbol and its callers, summarise:\n"
        "1. How many callers exist and in which files\n"
        "2. The most important call sites and what they do\n"
        "3. Whether the symbol is widely used or niche\n\n"
        "Keep it under 150 words."
    ),
    "wr_callees": (
        "You are a call-graph analyser. Given a symbol or file and its callees, "
        "summarise:\n"
        "1. What calls the symbol/file makes\n"
        "2. Key dependencies revealed\n"
        "3. Architecture implications\n\n"
        "Keep it under 150 words."
    ),
    "wr_importers": (
        "You are a dependency analyser. Given a module or file path and its "
        "importers, summarise:\n"
        "1. How many files import this module\n"
        "2. Which are the most important consumers\n"
        "3. Whether this is heavily depended-on or not\n\n"
        "Keep it under 150 words."
    ),
    "wr_exports": (
        "You are a module boundary analyser. Given a file and its exports, "
        "summarise:\n"
        "1. What the file exposes to consumers\n"
        "2. The public API surface\n"
        "3. Notable patterns\n\n"
        "Keep it under 150 words."
    ),
    "wr_arch_impact": (
        "You are an architecture impact analyser. Given a proposed change and a "
        "ranked list of affected files with reasons, summarise:\n"
        "1. The full impact radius (files + reasons)\n"
        "2. Which files are most critical\n"
        "3. Potential risks or concerns\n\n"
        "Keep it under 250 words."
    ),
    "wr_index_status": (
        "You are an index health summariser. Given index status data, summarise "
        "the health of the code-search index in one sentence."
    ),
}

DEFAULT_SYSTEM_PROMPT = (
    "You are a data summariser. Given tool output from a code-search system, "
    "provide a concise interpretation of what was found. Keep it under 150 words."
)

# ---------------------------------------------------------------------------
# Heuristic fallback (when no LLM is configured)
# ---------------------------------------------------------------------------

def _heuristic_interpret(tool: str, result: dict[str, Any]) -> str:
    """Extractive fallback that produces a minimal summary without an LLM."""
    if tool == "wr_index_status":
        c = result.get("collection", "?")
        s = result.get("status", "?")
        p = result.get("points_count", 0)
        return f"Collection '{c}' status: {s}, {p} points indexed."

    results = result.get("results") or result.get("files") or []
    count = result.get("count", len(results) if isinstance(results, list) else 0)
    if isinstance(results, list) and len(results) > 0:
        top = results[0]
        fp = top.get("file_path") or top.get("path") or top.get("name", "?")
        sym = top.get("symbol_name") or top.get("symbol") or ""
        extra = f" symbol={sym}" if sym else ""
        return f"Found {count} result(s). Top: {fp}.{extra}"
    if count > 0:
        return f"Found {count} result(s)."
    return "No results found."

# ---------------------------------------------------------------------------
# LLM client (lazy init)
# ---------------------------------------------------------------------------

_client = None


def _interpret_with_llm(tool: str, query: str | None, result: dict[str, Any]) -> dict[str, Any]:
    """Send to LLM via requests (Anthropic or OpenAI compatible) and return condensed interpretation."""
    system = SYSTEM_PROMPTS.get(tool, DEFAULT_SYSTEM_PROMPT)

    # Build a compact representation of the result to send to the LLM.
    result_summary = _compact_result(tool, result)

    user_content = f"Tool: {tool}\n"
    if query:
        user_content += f"Query: {query}\n"
    user_content += f"Result:\n{json.dumps(result_summary, indent=2, ensure_ascii=False)[:4000]}"

    try:
        import requests

        headers: dict[str, str] = {
            "Content-Type": "application/json",
        }
        # MiniMax uses X-Api-Key, OpenAI uses Authorization: Bearer
        if LLM_API_KEY_HEADER == "x-api-key":
            headers["X-Api-Key"] = LLM_API_KEY
        else:
            headers["Authorization"] = f"Bearer {LLM_API_KEY}"

        # Detect API style from base URL
        is_anthropic = "/anthropic" in LLM_BASE_URL.lower()

        if is_anthropic:
            # Anthropic-style: POST /v1/messages
            payload: dict[str, Any] = {
                "model": LLM_MODEL,
                "messages": [
                    {"role": "user", "content": f"{system}\n\n{user_content}"}
                ],
                "max_tokens": 300,
                "temperature": 0.1,
            }
            resp = requests.post(
                f"{LLM_BASE_URL}/messages",
                headers=headers,
                json=payload,
                timeout=LLM_TIMEOUT,
            )
            resp.raise_for_status()
            data = resp.json()
            # Anthropic returns content as array of blocks
            content_blocks = data.get("content", [])
            interpretation = ""
            for block in content_blocks:
                if isinstance(block, dict):
                    if block.get("type") == "text":
                        interpretation = block.get("text", "").strip()
                        break
                    elif block.get("type") == "thinking":
                        pass  # skip thinking blocks
            usage = data.get("usage", {})
            tokens_in = usage.get("input_tokens", 0)
            tokens_out = usage.get("output_tokens", 0)
        else:
            # OpenAI-style: POST /v1/chat/completions
            payload = {
                "model": LLM_MODEL,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user_content},
                ],
                "max_tokens": 300,
                "temperature": 0.1,
            }
            resp = requests.post(
                f"{LLM_BASE_URL}/chat/completions",
                headers=headers,
                json=payload,
                timeout=LLM_TIMEOUT,
            )
            resp.raise_for_status()
            data = resp.json()
            interpretation = (data.get("choices", [{}])[0].get("message", {}).get("content") or "").strip()
            usage = data.get("usage", {})
            tokens_in = usage.get("prompt_tokens", 0)
            tokens_out = usage.get("completion_tokens", 0)

        if not interpretation:
            interpretation = _heuristic_interpret(tool, result)

        return {
            "ok": True,
            "interpretation": interpretation,
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
        }
    except Exception as e:
        sys.stderr.write(f"[interpreter_worker] LLM call failed: {e}\n")
        return {
            "ok": True,
            "interpretation": _heuristic_interpret(tool, result),
            "tokens_in": 0,
            "tokens_out": 0,
        }


def _compact_result(tool: str, result: dict[str, Any]) -> dict[str, Any]:
    """Strip verbose fields from the raw result before sending to the LLM."""
    compact: dict[str, Any] = {}

    if tool == "wr_find":
        compact["query"] = result.get("query")
        results = result.get("results", [])
        compact["count"] = result.get("count", len(results))
        compact["mode"] = result.get("mode")
        compact["top_files"] = []
        seen_files: set[str] = set()
        for r in results[:20]:
            fp = r.get("file_path", "?")
            seen_files.add(fp)
            compact["top_files"].append({
                "file": fp,
                "score": round(r.get("score") or 0, 3),
                "symbol": r.get("symbol_name"),
                "language": r.get("language"),
                "lines": f"{r.get('start_line', '?')}-{r.get('end_line', '?')}",
                "preview": (r.get("preview") or "")[:200],
                "declared_symbols": r.get("declared_symbols", [])[:3],
            })
        compact["unique_files"] = len(seen_files)

    elif tool == "wr_file":
        compact["path"] = result.get("path")
        chunks = result.get("chunks", [])
        compact["chunk_count"] = len(chunks)
        symbols_seen: dict[str, list[str]] = {}
        for c in chunks:
            sk = c.get("symbol_kind") or "unknown"
            sn = c.get("symbol_name")
            if sn:
                symbols_seen.setdefault(sk, []).append(sn)
        compact["symbols"] = symbols_seen
        if chunks:
            compact["line_range"] = f"{chunks[0].get('start_line')}-{chunks[-1].get('end_line')}"
            compact["language"] = chunks[0].get("language")
            # Send first 800 chars of content as preview.
            compact["content_preview"] = (chunks[0].get("content") or "")[:800]

    elif tool in ("wr_impact", "wr_arch_impact"):
        compact["description"] = result.get("description")
        files = result.get("files", [])
        compact["file_count"] = len(files)
        compact["top_files"] = []
        for f in files[:15]:
            entry: dict[str, Any] = {
                "path": f.get("path") or f.get("file_path", "?"),
                "score": round(f.get("score") or f.get("total_score", 0), 3),
                "reasons": (f.get("reasons") or [])[:3],
                "top_symbols": (f.get("top_symbols") or [])[:3],
            }
            if "source" in f:
                entry["sources"] = f["source"]
            if "edges" in f:
                entry["edges"] = f["edges"][:5]
            compact["top_files"].append(entry)

    elif tool == "wr_symbol_find":
        compact["query"] = result.get("query")
        results = result.get("results", [])
        compact["count"] = len(results)
        compact["symbols"] = []
        for r in results[:20]:
            compact["symbols"].append({
                "name": r.get("name"),
                "kind": r.get("kind"),
                "file": r.get("file_path"),
                "fqn": r.get("fqn"),
                "score": round(r.get("score") or 0, 3),
            })

    elif tool in ("wr_callers", "wr_importers"):
        compact["symbol"] = result.get(result.get("symbol") is not None and "symbol" or "pathOrModule", "?")
        results = result.get("results", [])
        compact["count"] = len(results)
        compact["files"] = []
        seen_fps: set[str] = set()
        for r in results[:20]:
            fp = r.get("file_path", "?")
            seen_fps.add(fp)
            compact["files"].append({
                "path": fp,
                "symbol": r.get("symbol_name"),
                "lines": f"{r.get('start_line', '?')}-{r.get('end_line', '?')}",
                "preview": (r.get("preview") or "")[:150],
            })
        compact["unique_files"] = len(seen_fps)

    elif tool == "wr_callees":
        compact["symbolOrFile"] = result.get("symbolOrFile", "?")
        calls = result.get("calls", [])
        compact["call_count"] = len(calls)
        compact["calls"] = calls[:15]
        chunks = result.get("chunks", [])
        compact["chunk_count"] = len(chunks)

    elif tool == "wr_exports":
        compact["path"] = result.get("path", "?")
        exports = result.get("exports", [])
        compact["export_count"] = len(exports)
        compact["exports"] = exports[:20]

    elif tool == "wr_index_status":
        compact["collection"] = result.get("collection")
        compact["status"] = result.get("status")
        compact["points_count"] = result.get("points_count")

    else:
        compact = result

    return compact


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main() -> int:
    sys.stderr.write("INTERPRETER_WORKER_READY\n")
    sys.stderr.flush()

    for line in sys.stdin:
        line = line.rstrip("\n")
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            sys.stdout.write(
                json.dumps({"ok": False, "err": "invalid JSON"}) + "\n"
            )
            sys.stdout.flush()
            continue

        op = req.get("op", "interpret")
        if op == "ping":
            sys.stdout.write(json.dumps({"ok": True, "pong": True}) + "\n")
            sys.stdout.flush()
            continue

        if DISABLE_INTERPRETER:
            sys.stdout.write(
                json.dumps({
                    "ok": True,
                    "interpretation": "",
                    "tokens_in": 0,
                    "tokens_out": 0,
                    "disabled": True,
                }) + "\n"
            )
            sys.stdout.flush()
            continue

        try:
            tool = req.get("tool", "")
            query = req.get("query")
            result = req.get("result", {})
            resp = _interpret_with_llm(tool, query, result)
            sys.stdout.write(json.dumps(resp) + "\n")
        except Exception as e:
            sys.stderr.write(f"[interpreter_worker] error: {e}\n")
            sys.stdout.write(
                json.dumps({
                    "ok": True,
                    "interpretation": _heuristic_interpret(
                        req.get("tool", ""), req.get("result", {})
                    ),
                    "tokens_in": 0,
                    "tokens_out": 0,
                }) + "\n"
            )
        sys.stdout.flush()

    return 0


if __name__ == "__main__":
    sys.exit(main())
