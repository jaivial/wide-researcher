# wide-researcher — Python indexer + research engine

The Python side of wide-researcher. Two packages:

- **`indexer/`** — walks a project, chunks each file (AST-aware for
  ts/tsx/csharp/python/go/rust; heading-based for markdown;
  key-based for JSON locales), embeds the chunks with MiniLM-L6, and
  upserts into a per-project Qdrant collection. Tracks file→hash in
  a sidecar JSON so incremental reindex is O(changed files), not
  O(repo size).

- **`scripts/`** — research + diagram tools that run against a
  ready collection:
  - `wide_research.py` — impact-radius research; emits
    `research-context.json` + `impact-diagram.html`.
  - `init_collection.py` — idempotent Qdrant collection bootstrap
    (vector + payload indexes).
  - `diagram_render.py` — React-Flow HTML renderer (imported by
    `wide_research.py`; standalone usable too).

## Configuration

Everything is driven by a project-local JSON file. Point the
`WIDE_RESEARCHER_PROJECT_CONFIG` environment variable at it before
running anything:

```bash
export WIDE_RESEARCHER_PROJECT_CONFIG=/abs/path/.wide-researcher/config.json
```

Minimum schema:

```json
{
  "project_name": "myapp",
  "project_root": "/abs/path/to/project",
  "collection_name": "myapp_a1b2c3d4"
}
```

See `indexer/config.py` for the full schema (qdrant URL, model path,
batch size, extra excludes, file-index sidecar path, etc.).

## Running

```bash
# bootstrap the qdrant collection (idempotent)
python3 -m scripts.init_collection

# full reindex
python3 -m indexer reindex

# incremental (hash-based skip)
python3 -m indexer incremental

# single file (debug)
python3 -m indexer file /abs/path/to/file.ts

# impact-radius research
python3 -m scripts.wide_research --prompt "your task description"
```

## How the Node CLI invokes this

The `wide-researcher` npm bin (in `bin/wide-researcher.js`) spawns
the indexer + scripts as Python subprocesses through the venv at
`~/.wide-researcher/venv/`. End users never run these by hand —
they're an implementation detail of `wide-researcher init`,
`wide-researcher reindex`, etc.

## Why subprocess-per-file

`sentence-transformers` / PyTorch leak intermediate buffers slowly
on every batch (~5-15 MB per batch in our profiling). On a 50k-file
repo a single long-running process accumulates >12 GB RSS and
OOMs. The indexer's `_run_index` loop re-instantiates the model
every 500 files (`indexer.embed._model = None; gc.collect()`).
The watcher daemon goes one further — it spawns a fresh subprocess
per debounce-batch, which gives the kernel a clean reclamation
opportunity after each save.
