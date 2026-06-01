[Unit]
Description=wide-researcher · filesystem watcher for {{PROJECT_NAME}}
After=qdrant.service
Wants=qdrant.service

[Service]
Type=simple
Environment=WIDE_RESEARCHER_PROJECT_CONFIG={{PROJECT_CONFIG}}
Environment=OMP_NUM_THREADS=2
Environment=ORT_NUM_THREADS=2
Environment=MKL_NUM_THREADS=2
Environment=OPENBLAS_NUM_THREADS=2
ExecStart={{VENV_PYTHON}} -m scripts.watcher --verbose
WorkingDirectory={{PY_ROOT}}
Restart=on-failure
RestartSec=3

# Resource caps — watcher spawns subprocesses, so cap conservatively.
CPUQuota=200%
MemoryMax=4G
TasksMax=512

StandardOutput=append:{{LOG_DIR}}/indexer-{{PROJECT_SLUG}}.log
StandardError=append:{{LOG_DIR}}/indexer-{{PROJECT_SLUG}}.log

[Install]
WantedBy=default.target
