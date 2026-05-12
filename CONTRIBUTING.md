# Contributing

Thanks for considering a contribution to `wide-researcher`.

## Local dev loop

```bash
git clone https://github.com/jaivial/wide-researcher.git
cd wide-researcher
npm install
npm run build
```

You now have `bin/wide-researcher.js` runnable against the source.

```bash
node bin/wide-researcher.js --help
node bin/wide-researcher.js status        # safe — read-only
```

For an isolated install + reinstall loop, point at an empty test
project:

```bash
mkdir /tmp/wr-test
cd /tmp/wr-test
node /var/www/wide-researcher/bin/wide-researcher.js init \
  --force --no-reindex --no-supervisor
```

`--no-reindex` skips the (slow) initial walk; `--no-supervisor`
skips systemd/launchd registration so the test doesn't pollute your
user units.

## Project layout

```
wide-researcher/
├── bin/                            ← npm bin stubs (node ESM imports dist/)
│   ├── wide-researcher.js
│   └── wide-researcher-mcp.js
├── src/                            ← TypeScript source — npm run build → dist/
│   ├── cli.ts                      ← commander entry
│   ├── commands/                   ← one file per CLI subcommand
│   ├── installers/                 ← idempotent install steps
│   ├── mcp-server/                 ← stdio MCP server
│   └── utils/                      ← paths, platform, log, exec, template
├── python/                         ← shipped as-is (not transpiled)
│   ├── indexer/                    ← `python -m indexer` package
│   ├── scripts/                    ← wide_research / diagram / watcher / embed_worker
│   ├── requirements.txt
│   └── README.md
├── templates/                      ← rendered into ~/.wide-researcher/ or <project>/
│   ├── systemd/                    ← *.service.tpl
│   ├── launchd/                    ← *.plist.tpl
│   └── claude/                     ← agent + skill bundle
└── docs/                           ← INSTALL · ARCHITECTURE · PRIVACY · TROUBLESHOOTING
```

## Quality gates (run before opening a PR)

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint src/
npm run build        # tsc → dist/
python3 -m py_compile python/indexer/*.py python/scripts/*.py
```

CI runs all of the above on every PR (see
`.github/workflows/ci.yml`).

## Style

- **TypeScript**: strict mode, no `any`, narrow types over wide
  ones. ESM throughout. `import { foo } from './bar.js'` (note the
  `.js` extension — that's TS-ESM convention).
- **Python**: stdlib only where possible; `from __future__ import
  annotations` at the top. Tree-sitter for AST chunking — never
  hand-rolled regex parsing.
- **Commits**: conventional commit prefixes (`feat:`, `fix:`,
  `chore:`, `docs:`, `refactor:`). Body explains the **why** not
  the **what** — diffs already show the what.
- **PRs**: one logical change per PR. If you find yourself
  needing two `feat:` headers, split it.

## Adding a new chunker

To add language `<lang>`:

1. Add the suffix → language mapping in `python/indexer/walk.py`
   (`LANG_BY_SUFFIX`).
2. Write `python/indexer/chunker_<lang>.py` modelled on
   `chunker_py.py`. Export `chunk_<lang>(source: str) ->
   list[Chunk]`.
3. Dispatch in `python/indexer/chunker.py::chunk_file`.
4. Add a smoke test under `python/indexer/__tests__/` (TBD —
   first chunker test arrives in Phase 10).

## Releasing

Maintainer-only:

```bash
# 1. Bump version
npm version <patch|minor|major>

# 2. Push
git push origin main --tags

# 3. Create GitHub release
gh release create v<x.y.z> --generate-notes

# 4. Publish to npm (gated on CI green)
npm publish
```

## Code of conduct

Be kind. Be specific. Lead with evidence. No drive-by negativity in
issues or PRs. Maintainers reserve the right to close
non-constructive threads.
