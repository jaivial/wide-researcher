[Unit]
Description=wide-researcher · qdrant vector database
After=network.target

[Service]
Type=simple
ExecStart={{QDRANT_BIN}} --config-path {{QDRANT_CONFIG}}
Restart=on-failure
RestartSec=2
WorkingDirectory={{QDRANT_ROOT}}

# Resource caps — keep qdrant from running away on shared dev boxes.
CPUQuota=200%
MemoryMax=2G
TasksMax=512

# Sane logging
StandardOutput=append:{{LOG_DIR}}/qdrant.log
StandardError=append:{{LOG_DIR}}/qdrant.log

[Install]
WantedBy=default.target
