<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.wide-researcher.indexer.{{PROJECT_SLUG}}</string>

    <key>ProgramArguments</key>
    <array>
        <string>{{VENV_PYTHON}}</string>
        <string>-m</string>
        <string>scripts.watcher</string>
        <string>--verbose</string>
    </array>

    <key>WorkingDirectory</key>
    <string>{{PY_ROOT}}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>StandardOutPath</key>
    <string>{{LOG_DIR}}/indexer-{{PROJECT_SLUG}}.log</string>

    <key>StandardErrorPath</key>
    <string>{{LOG_DIR}}/indexer-{{PROJECT_SLUG}}.log</string>

    <key>Nice</key>
    <integer>5</integer>

    <key>EnvironmentVariables</key>
    <dict>
        <key>WIDE_RESEARCHER_PROJECT_CONFIG</key>
        <string>{{PROJECT_CONFIG}}</string>
        <key>OMP_NUM_THREADS</key>
        <string>2</string>
        <key>ORT_NUM_THREADS</key>
        <string>2</string>
        <key>MKL_NUM_THREADS</key>
        <string>2</string>
        <key>OPENBLAS_NUM_THREADS</key>
        <string>2</string>
    </dict>
</dict>
</plist>
