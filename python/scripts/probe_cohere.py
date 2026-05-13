#!/usr/bin/env python3
"""Cohere API probe used during `wide-researcher init` to validate the API key."""
import subprocess
import sys

# Ensure cohere is available
try:
    import cohere
except ImportError:
    print("cohere not installed, installing...", file=sys.stderr)
    r = subprocess.run(
        [sys.executable, "-m", "pip", "install", "cohere>=5.13"],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        print("pip install cohere failed:", r.stderr, file=sys.stderr)
        sys.exit(2)
    import cohere  # noqa: E702

import os

key = os.environ.get("COHERE_API_KEY", "")
model_id = os.environ.get("COHERE_EMBED_MODEL", "embed-v4.0")

if not key or len(key) < 20:
    print("COHERE_API_KEY not set or too short", file=sys.stderr)
    sys.exit(1)

client = cohere.ClientV2(key)
r = client.embed(
    model=model_id,
    input_type="search_document",
    embedding_types=["float"],
    texts=["probe"],
)
dim = len(r.embeddings.float[0])
print(f"cohere ok, dim: {dim}")
