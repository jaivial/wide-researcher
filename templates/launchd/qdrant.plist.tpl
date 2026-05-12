<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.wide-researcher.qdrant</string>

    <key>ProgramArguments</key>
    <array>
        <string>{{QDRANT_BIN}}</string>
        <string>--config-path</string>
        <string>{{QDRANT_CONFIG}}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>{{QDRANT_ROOT}}</string>

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
    <string>{{LOG_DIR}}/qdrant.log</string>

    <key>StandardErrorPath</key>
    <string>{{LOG_DIR}}/qdrant.log</string>

    <!-- Resource hints. macOS has no direct equivalent of CPUQuota/MemoryMax.
         The Nice value softly de-prioritises this process; the env vars cap
         the embed worker's thread count (which is the real CPU hog). -->
    <key>Nice</key>
    <integer>5</integer>

    <key>EnvironmentVariables</key>
    <dict>
        <key>OMP_NUM_THREADS</key>
        <string>2</string>
        <key>ORT_NUM_THREADS</key>
        <string>2</string>
    </dict>
</dict>
</plist>
