"""React-Flow based renderer for wide-researcher impact diagrams.

Emits a standalone HTML file that loads React + ReactDOM + reactflow via
esm.sh at runtime. No build step, no bundler. Open in any modern browser
with network access; data is inlined as JSON.

Public entry: render_html(prompt, files, slug, generated_at, project_root=None) -> str
"""
from __future__ import annotations

import html as html_lib
import json
import math
import os
from typing import Iterable

RING_RADII_PX = [220, 420, 620, 820]

# Set by render_html() before any _short() call. The renderer trims this prefix
# from absolute paths so cards stay readable.
_PROJECT_ROOT_TRAILING_SEP: str = ""


def _short(path: str) -> str:
    if _PROJECT_ROOT_TRAILING_SEP and path.startswith(_PROJECT_ROOT_TRAILING_SEP):
        return path[len(_PROJECT_ROOT_TRAILING_SEP):]
    return path


def _ring_for(rank: int, total: int) -> int:
    if total == 0:
        return 0
    band = rank / max(total - 1, 1)
    if band < 0.15:
        return 0
    if band < 0.40:
        return 1
    if band < 0.70:
        return 2
    return 3


def _edges_between(positioned: list[dict]) -> list[dict]:
    """Same 3-type relation logic as before, but emitting reactflow-edge dicts."""
    out: list[dict] = []
    n = len(positioned)
    for i in range(n):
        a = positioned[i]
        sa = {s for s in a["f"].get("symbols", []) if s}
        for j in range(i + 1, n):
            b = positioned[j]
            sb = {s for s in b["f"].get("symbols", []) if s}
            kind = None
            reason = ""
            if sa & sb:
                kind = "symbol"
                reason = "shares symbol: " + ", ".join(sorted(sa & sb)[:2])
            elif a["f"].get("agent_owner") and a["f"].get("agent_owner") == b["f"].get("agent_owner"):
                kind = "owner"
                reason = f"same owner: {a['f']['agent_owner']}"
            else:
                pa = os.path.dirname(a["f"]["file_path"])
                pb = os.path.dirname(b["f"]["file_path"])
                if pa == pb:
                    kind = "dir"
                    reason = f"same dir: {pa.split('/')[-1] or '/'}"
            if kind:
                out.append({
                    "id": f"e-{a['id']}-{b['id']}",
                    "source": a["id"],
                    "target": b["id"],
                    "kind": kind,
                    "reason": reason,
                })
    # Cap to keep diagram readable
    sym = [e for e in out if e["kind"] == "symbol"]
    own = [e for e in out if e["kind"] == "owner"][:30]
    dr = [e for e in out if e["kind"] == "dir"][:20]
    return sym + own + dr


def _build_payload(prompt: str, files: list[dict], slug: str, generated_at: str) -> dict:
    """Build the JSON payload that the in-browser React Flow app will consume."""
    # Position files on concentric rings; ring 0 = direct hit, ring 3 = distant.
    rings: list[list[dict]] = [[], [], [], []]
    for rank, f in enumerate(files):
        rings[_ring_for(rank, len(files))].append(f)

    nodes: list[dict] = []
    positioned: list[dict] = []
    nid = 1
    for ring_idx, ring_files in enumerate(rings):
        n = len(ring_files)
        if n == 0:
            continue
        radius = RING_RADII_PX[ring_idx]
        # spread nodes around the ring; per-ring angular offset prevents stacking
        angular_offset = (ring_idx * 0.5)
        for i, f in enumerate(ring_files):
            angle = (2 * math.pi * i / n) + angular_offset
            x = math.cos(angle) * radius
            y = math.sin(angle) * radius
            node_id = f"f{nid}"
            nid += 1
            data = {
                "id": node_id,
                "path": _short(f["file_path"]),
                "fullPath": f["file_path"],
                "repo": f.get("repo") or "",
                "language": f.get("language") or "",
                "agent_owner": f.get("agent_owner") or "",
                "atomic_layer": f.get("atomic_layer") or "",
                "symbols": f.get("symbols") or [],
                "lines": f.get("lines") or [],
                "score": round(f.get("score", 0.0), 3),
                "chunks": f.get("chunks", 0),
                "ring": ring_idx,
            }
            nodes.append({
                "id": node_id,
                "type": "fileNode",
                "position": {"x": x, "y": y},
                "data": data,
            })
            positioned.append({"id": node_id, "f": f})

    # Centre origin node (the prompt itself)
    nodes.insert(0, {
        "id": "origin",
        "type": "originNode",
        "position": {"x": 0, "y": 0},
        "data": {"prompt": prompt},
        "draggable": False,
    })

    # Edges between files (symbol / owner / dir clusters)
    edges = _edges_between(positioned)

    # Hub-and-spoke baseline — origin → every node, styled by ring so closer
    # rings get a stronger spoke and outer rings fade out. Guarantees no
    # orphan nodes.
    origin_edges = []
    ring_kind = {0: "origin0", 1: "origin1", 2: "origin2", 3: "origin3"}
    ring_reason = {
        0: "ring 0 · direct semantic hit",
        1: "ring 1 · close cluster",
        2: "ring 2 · adjacent cluster",
        3: "ring 3 · distant cluster",
    }
    for p in positioned:
        node_data = next((n for n in nodes if n["id"] == p["id"]), {}).get("data", {})
        r = node_data.get("ring", 3)
        origin_edges.append({
            "id": f"e-origin-{p['id']}",
            "source": "origin",
            "target": p["id"],
            "kind": ring_kind.get(r, "origin3"),
            "reason": ring_reason.get(r, "impact"),
        })

    # Inter-ring proximity — each non-ring0 node also connects to its single
    # NEAREST node in the previous (inner) ring, so visually you can trace
    # impact propagating outward.
    proximity_edges = []
    by_ring: dict[int, list[dict]] = {0: [], 1: [], 2: [], 3: []}
    pos_index: dict[str, dict] = {}
    for p in positioned:
        nd = next((n for n in nodes if n["id"] == p["id"]), {})
        info = {
            "id": p["id"],
            "x": nd["position"]["x"],
            "y": nd["position"]["y"],
            "f": p["f"],
            "ring": nd.get("data", {}).get("ring", 3),
        }
        by_ring[info["ring"]].append(info)
        pos_index[p["id"]] = info
    for r in (1, 2, 3):
        inner = by_ring.get(r - 1) or []
        if not inner:
            continue
        for outer in by_ring.get(r, []):
            best = min(
                inner,
                key=lambda inn: (outer["x"] - inn["x"]) ** 2 + (outer["y"] - inn["y"]) ** 2,
            )
            proximity_edges.append({
                "id": f"e-prox-{best['id']}-{outer['id']}",
                "source": best["id"],
                "target": outer["id"],
                "kind": "proximity",
                "reason": "nearest inner-ring neighbour",
            })

    # Spatial-neighbor edges — every node connects to its 2 nearest physical
    # neighbors (in any ring). Guarantees every card has visible edges and
    # makes the connectivity of the diagram obvious.
    neighbor_edges = []
    seen_pairs: set[tuple[str, str]] = set()
    all_infos = list(pos_index.values())
    for a in all_infos:
        ranked = sorted(
            (b for b in all_infos if b["id"] != a["id"]),
            key=lambda b: (a["x"] - b["x"]) ** 2 + (a["y"] - b["y"]) ** 2,
        )
        for b in ranked[:2]:
            key = tuple(sorted((a["id"], b["id"])))
            if key in seen_pairs:
                continue
            seen_pairs.add(key)
            neighbor_edges.append({
                "id": f"e-nb-{key[0]}-{key[1]}",
                "source": a["id"],
                "target": b["id"],
                "kind": "neighbor",
                "reason": "spatial neighbour",
            })

    edges = origin_edges + proximity_edges + neighbor_edges + edges

    return {
        "prompt": prompt,
        "slug": slug,
        "generatedAt": generated_at,
        "fileCount": len(files),
        "edgeCount": len(edges),
        "nodes": nodes,
        "edges": edges,
    }


_SCRIPT = """
import React, { useMemo, useCallback } from 'https://esm.sh/react@18';
import { createRoot } from 'https://esm.sh/react-dom@18/client?deps=react@18';
import ReactFlow, {
  Background, Controls, MiniMap, Handle, Position,
} from 'https://esm.sh/reactflow@11.11.4?deps=react@18,react-dom@18';

const DATA = __DATA_JSON__;

const ringColor = (r) => ['#2ea043', '#d29922', '#f85149', '#6e7681'][r] || '#6e7681';

function OriginNode({ data }) {
  return React.createElement('div', { className: 'origin-card' },
    React.createElement(Handle, { type: 'target', position: Position.Top, id: 't', style: { opacity: 0 } }),
    React.createElement('small', null, 'ORIGIN · USER PROMPT'),
    React.createElement('div', { className: 'origin-prompt' }, data.prompt),
    React.createElement(Handle, { type: 'source', position: Position.Bottom, id: 's', style: { opacity: 0 } })
  );
}

function FileNode({ data }) {
  const lineStr = (data.lines && data.lines.length)
    ? 'L' + data.lines[0][0] + '-' + data.lines[0][1] + (data.lines.length > 1 ? ' +' + (data.lines.length - 1) : '')
    : '';
  return React.createElement('div', {
    className: 'file-card ring-' + data.ring,
    title: data.fullPath + '\\nscore=' + data.score + ' · chunks=' + data.chunks
            + '\\nowner=' + (data.agent_owner || '-')
            + '\\nlayer=' + (data.atomic_layer || '-')
            + '\\nsymbols: ' + ((data.symbols || []).slice(0, 3).join(', ') || '(none)')
  },
    React.createElement(Handle, { type: 'target', position: Position.Top, id: 't', style: { opacity: 0 } }),
    React.createElement('div', { className: 'file-card-bar', style: { background: ringColor(data.ring) } }),
    React.createElement('div', { className: 'file-card-body' },
      React.createElement('div', { className: 'file-card-path' }, data.path),
      React.createElement('div', { className: 'file-card-meta' },
        React.createElement('span', { className: 'badge' }, data.language || data.repo || '-'),
        data.agent_owner ? React.createElement('span', { className: 'badge owner' }, data.agent_owner) : null,
        React.createElement('span', { className: 'score' }, data.score.toFixed(3)),
      ),
      (data.symbols && data.symbols.length)
        ? React.createElement('div', { className: 'file-card-symbols' }, (data.symbols.slice(0, 3)).join(', '))
        : null,
      lineStr
        ? React.createElement('div', { className: 'file-card-lines' }, lineStr + ' · ' + data.chunks + ' chunk' + (data.chunks > 1 ? 's' : ''))
        : null
    ),
    React.createElement(Handle, { type: 'source', position: Position.Bottom, id: 's', style: { opacity: 0 } })
  );
}

const nodeTypes = { fileNode: FileNode, originNode: OriginNode };

function edgeStyle(kind) {
  switch (kind) {
    case 'origin0':   return { stroke: '#79c0ff', strokeWidth: 2.8, strokeOpacity: 1.0 };
    case 'origin1':   return { stroke: '#79c0ff', strokeWidth: 2.0, strokeOpacity: 0.85 };
    case 'origin2':   return { stroke: '#79c0ff', strokeWidth: 1.6, strokeOpacity: 0.70 };
    case 'origin3':   return { stroke: '#79c0ff', strokeWidth: 1.3, strokeOpacity: 0.55 };
    case 'proximity': return { stroke: '#a5d6ff', strokeWidth: 1.6, strokeOpacity: 0.80, strokeDasharray: '6 4' };
    case 'neighbor':  return { stroke: '#a5d6ff', strokeWidth: 1.2, strokeOpacity: 0.60 };
    case 'symbol':    return { stroke: '#3fb950', strokeWidth: 2.2, strokeOpacity: 0.95 };
    case 'owner':     return { stroke: '#e3b341', strokeWidth: 1.6, strokeOpacity: 0.75, strokeDasharray: '4 3' };
    case 'dir':       return { stroke: '#b1bac4', strokeWidth: 1.2, strokeOpacity: 0.60, strokeDasharray: '1 4' };
    default:          return { stroke: '#8b949e', strokeWidth: 1.0, strokeOpacity: 0.55 };
  }
}

function App() {
  const nodes = useMemo(() => DATA.nodes, []);
  const edges = useMemo(() =>
    DATA.edges.map(e => ({
      id: e.id, source: e.source, target: e.target,
      // 'default' = bezier in React Flow 11. 'straight' = polyline.
      type: (e.kind && e.kind.indexOf('origin') === 0) ? 'default' : 'straight',
      animated: false,
      style: edgeStyle(e.kind),
      label: '',
      data: { kind: e.kind, reason: e.reason },
    })), []);

  const onEdgeMouseEnter = useCallback((_, edge) => {
    const el = document.getElementById('hint');
    if (el && edge?.data?.reason) el.textContent = edge.data.reason;
  }, []);
  const onEdgeMouseLeave = useCallback(() => {
    const el = document.getElementById('hint');
    if (el) el.textContent = '';
  }, []);

  return React.createElement(ReactFlow, {
    nodes, edges, nodeTypes,
    fitView: true,
    fitViewOptions: { padding: 0.22, includeHiddenNodes: false },
    minZoom: 0.15, maxZoom: 2,
    nodesDraggable: true,
    nodesConnectable: false,
    elementsSelectable: true,
    proOptions: { hideAttribution: true },
    onEdgeMouseEnter, onEdgeMouseLeave,
    defaultEdgeOptions: { type: 'default' },
  },
    React.createElement(Background, { color: '#21262d', gap: 32, size: 1 }),
    React.createElement(MiniMap, { pannable: true, zoomable: true,
      style: { background: '#161b22' },
      nodeColor: (n) => n.type === 'originNode' ? '#58a6ff' : ringColor(n.data?.ring || 3),
      maskColor: 'rgba(13,17,23,.7)' }),
    React.createElement(Controls, { showInteractive: false }),
  );
}

createRoot(document.getElementById('root')).render(React.createElement(App));
"""


def render_html(
    prompt: str,
    files: list[dict],
    slug: str,
    generated_at: str,
    project_root: str | None = None,
) -> str:
    global _PROJECT_ROOT_TRAILING_SEP
    if project_root:
        _PROJECT_ROOT_TRAILING_SEP = project_root.rstrip(os.sep) + os.sep
    else:
        _PROJECT_ROOT_TRAILING_SEP = ""

    payload = _build_payload(prompt, files, slug, generated_at)
    payload_json = json.dumps(payload, ensure_ascii=False)
    safe_prompt = html_lib.escape(prompt)
    safe_slug = html_lib.escape(slug)
    safe_gen = html_lib.escape(generated_at)
    script = _SCRIPT.replace("__DATA_JSON__", payload_json)

    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>wide-researcher · {safe_slug}</title>
<link rel="stylesheet" href="https://esm.sh/reactflow@11.11.4/dist/style.css">
<style>
  :root {{
    --bg: #0d1117; --panel: #161b22; --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
  }}
  html, body, #root {{ margin:0; padding:0; height:100%; background:var(--bg); color:var(--text); }}
  body {{ font-family: ui-sans-serif, system-ui, -apple-system, "Inter", sans-serif; overflow:hidden; }}

  header {{
    position:fixed; top:0; left:0; right:0; z-index:50;
    padding: .75rem 1.25rem; background: rgba(13,17,23,.92); backdrop-filter: blur(8px);
    border-bottom: 1px solid #21262d; display:flex; gap:1rem; align-items:center;
  }}
  header h1 {{ font-size:.95rem; margin:0; color:var(--accent); font-weight:600; }}
  header .meta {{ font-size:.75rem; color:var(--muted); margin-left:auto; font-variant-numeric: tabular-nums; }}
  header #hint {{ color:#aacbff; font-size:.78rem; font-family:ui-monospace,monospace; }}

  #root {{ padding-top: 56px; box-sizing: border-box; }}

  /* Origin (centre) card */
  .origin-card {{
    background: linear-gradient(180deg, #1f6feb 0%, #0d419d 100%);
    color:#fff; padding: 1rem 1.25rem; border-radius: 12px;
    box-shadow: 0 8px 30px #1f6feb55;
    max-width: 380px; min-width: 240px;
    text-align: center; font-weight: 600; font-size: .9rem; line-height: 1.35;
  }}
  .origin-card small {{
    display:block; color:#aacbff; font-weight:400;
    text-transform:uppercase; font-size:.62rem; letter-spacing:.1em; margin-bottom:.4rem;
  }}
  .origin-prompt {{ font-weight: 600; }}

  /* File cards */
  .file-card {{
    background: #161b22; border: 1px solid #30363d; border-radius: 10px;
    min-width: 240px; max-width: 340px; box-shadow: 0 2px 10px #0008;
    overflow: hidden; display: flex;
    transition: border-color .15s ease, background .15s ease, transform .15s ease;
  }}
  .file-card:hover {{ border-color: var(--accent); background: #1f2937; transform: translateY(-1px); }}
  .file-card-bar {{ width: 4px; flex-shrink: 0; }}
  .file-card-body {{ padding: .55rem .7rem; flex: 1; min-width: 0; }}
  .file-card-path {{ color:var(--text); font-family: ui-monospace, monospace; font-size:.72rem;
                     word-break: break-all; line-height: 1.3; }}
  .file-card-meta {{ display:flex; gap:.4rem; align-items:center; margin-top:.35rem;
                     color:var(--muted); font-size:.68rem; flex-wrap: wrap; }}
  .badge {{ background:#21262d; padding:1px 6px; border-radius:4px; color:var(--muted);
            font-size:.62rem; }}
  .badge.owner {{ background:#1c3d5a; color:#aacbff; }}
  .score {{ margin-left:auto; color: var(--accent); font-variant-numeric: tabular-nums;
            font-family: ui-monospace, monospace; }}
  .file-card-symbols {{ color:#aacbff; font-family:ui-monospace,monospace; font-size:.65rem;
                        margin-top:.35rem; word-break: break-all; }}
  .file-card-lines {{ color:var(--muted); font-family:ui-monospace,monospace; font-size:.62rem;
                      margin-top:.2rem; }}

  /* Ring accent (left-bar already coloured via inline style) */
  .file-card.ring-0 {{ border-color: #2ea04388; }}
  .file-card.ring-1 {{ border-color: #d2992288; }}
  .file-card.ring-2 {{ border-color: #f8514988; }}
  .file-card.ring-3 {{ border-color: #6e768188; }}

  /* React Flow tweaks for dark theme */
  .react-flow__handle {{ opacity: 0; }}
  .react-flow__controls {{ background: #161b22 !important; }}
  .react-flow__controls button {{ background: #161b22 !important; color: #e6edf3 !important;
                                  border-bottom: 1px solid #30363d !important; }}
  .react-flow__controls button:hover {{ background: #1f2937 !important; }}
  .react-flow__minimap {{ border-radius: 6px; }}
</style>
</head><body>
<header>
  <h1>wide-researcher · impact radius</h1>
  <span id="hint"></span>
  <div class="meta">{safe_slug} · {safe_gen} · {len(payload['nodes']) - 1} files · {len(payload['edges'])} edges</div>
</header>
<div id="root"></div>
<script type="module">
{script}
</script>
</body></html>
"""
