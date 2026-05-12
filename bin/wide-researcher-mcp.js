#!/usr/bin/env node
// Entry-point stub for the MCP server. Claude Code spawns this via
// `.mcp.json` with `--project-config <abs-path>` argv supplied.

import('../dist/mcp-server/server.js').catch((err) => {
  if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
    process.stderr.write(
      'wide-researcher-mcp: build artifact missing.\n' +
        '  Run `npm run build` first (dev), or reinstall wide-researcher (prod).\n',
    );
    process.exit(2);
  }
  process.stderr.write(`wide-researcher-mcp fatal: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
