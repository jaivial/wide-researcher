#!/usr/bin/env node
// Entry-point stub. The real CLI lives in src/cli.ts and is compiled to
// dist/cli.js by `npm run build`. This stub is what `npm install -g`
// puts on the user's PATH.

import('../dist/cli.js').catch((err) => {
  if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
    // Local dev: build hasn't run yet.
    console.error(
      'wide-researcher: build artifact missing.\n' +
      '  - If you are developing locally, run `npm run build` first.\n' +
      '  - If you installed via npm, this is a packaging bug — file an issue.',
    );
    process.exit(2);
  }
  console.error(err);
  process.exit(1);
});
