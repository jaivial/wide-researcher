# Plan: Neo4j auto-install, MCP env injection, README update, npm publish

**Slug:** `neo4j-autoinstall-npm-publish`
**Created:** 2026-05-21
**Repo:** `/var/www/wide-researcher` (`jaivial/wide-researcher`, `main`)
**Current version:** `0.1.0-alpha.24`
**Target version:** `0.1.0-alpha.25`
**NPM auth:** `jaivial` (valid token in `/root/.npmrc`)
**Git remote:** `https://github.com/jaivial/wide-researcher.git`

---

## 1. Context Discovery

### 1.1 Runtime environment (verified 2026-05-21)

| Item | Value |
|------|-------|
| Neo4j version | 2026.04.0, service `active`, Bolt `127.0.0.1:7687` |
| Neo4j credentials | `neo4j` / `txUBtAlt0#NF8cU3vubiF5l9Cu=IgKfF`, database `neo4j` |
| MCP server binary | `/var/www/wide-researcher/bin/wide-researcher-mcp.js` |
| Project config loaded from | `--project-config <path>` argv (or `WIDE_RESEARCHER_PROJECT_CONFIG` env) |
| Current graph provider | `qdrant` (default); `neo4j` when set in config.json |
| `neo4j-sync` command | Exists at `src/commands/neo4j-sync.ts:172`; reads env vars `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD` |
| MCP installer | `src/installers/claude-bundle.ts:348` `writeMcpStanza()` — currently writes only `PYTHON_BIN` to `.mcp.json` env |
| Existing patches (already applied) | `neo4j.ts:29-63` — `neo4jConfigError()` and `getDriver()` fallback to `cfg.neo4j.uri/user/password` from config.json |
| Python indexer config | `python/indexer/config.py:104-108` — also reads same env var names |

### 1.2 Impacted files

| File | Role | Change needed |
|------|------|---------------|
| `src/commands/neo4j-sync.ts:23-36` `envConfig()` | Currently reads only env vars | Must also try config.json direct fields as fallback (like `neo4j.ts` already does) |
| `src/installers/claude-bundle.ts:382-389` `writeMcpStanza()` | Writes `.mcp.json` env block | Add NEO4J_* env vars when `graph_provider=neo4j` and credentials exist in config.json |
| `src/installers/claude-bundle.ts:397-414` `installClaudeBundle()` | Init/add flow | Add `runNeo4jSetup` as optional post-install step when config has `graph_provider: "neo4j"` |
| `src/cli.ts:170-180` | CLI command registration | Add `neo4j-setup` command + maybe `--with-neo4j` flag to `init`/`add` |
| `src/mcp-server/config.ts:96-105` | Config loader (already patched) | Already has `uri/user/password/database` — verify persistence after merge |
| `src/mcp-server/neo4j.ts:29-78` | Neo4j driver (already patched) | Already has config.json fallback — verify persistence after merge |
| `README.md:227-235` | Neo4j section | Needs rewrite: auto-setup, direct credential fields, MCP env injection |
| `package.json` | Version bump | `0.1.0-alpha.24` → `0.1.0-alpha.25` |

---

## 2. Tasks

### Task A — Create `src/commands/neo4j-setup.ts`

**File:** new file at `src/commands/neo4j-setup.ts`

**Purpose:** CLI command `wide-researcher neo4j-setup` that:
1. Checks if Neo4j is installed (`which neo4j`, `systemctl is-active neo4j`, try Bolt connect at configurable URI)
2. If not installed: prints OS-specific install instructions (apt: `apt-get install neo4j`, brew: `brew install neo4j`, Windows: link to download)
3. If installed but not running: prints start command
4. Prompts user for Bolt URI / credentials (or reads from existing config.json / env)
5. Tests Bolt connection
6. Writes credentials into `.wide-researcher/config.json` under the `neo4j` block (keys: `uri`, `user`, `password`, `database`)
7. Re-runs `writeMcpStanza` to inject NEO4J_* env vars into `.mcp.json`
8. Runs `neo4j-sync` (call `runNeo4jSync` from the existing command)

**Behavioral cases:**
| # | Case | Expected |
|---|------|----------|
| B1 | Neo4j already installed + running + credentials in config | no-op, print "already configured" |
| B2 | Neo4j installed but not running | print start instructions |
| B3 | Neo4j not installed at all | print OS-specific install guide |
| B4 | Bolt connection fails | print error + retry credential prompt |
| B5 | `--non-interactive` flag set + credentials missing | exit with message |
| B6 | `graph_provider` is `qdrant` | skip, print "not needed" |

**TDD approach:** Write tests in `src/commands/__tests__/neo4j-setup.test.ts` mocking:
- `child_process.execSync` for `which neo4j` / `systemctl is-active`
- `neo4j.driver` for Bolt connect
- `fs` for config read/write

**Verbatim anchors:**
- Model after `src/commands/neo4j-sync.ts:172-189` (`runNeo4jSync`) for CLI/installer patterns
- Import `writeMcpStanza` from `src/installers/claude-bundle.ts` (currently internal → needs export)
- Config read: use `loadProjectConfig` from `src/mcp-server/config.ts:39`
- Config write: use `readFileSync`/`writeFileSync` with JSON parse/merge/dump (same pattern as `src/installers/claude-bundle.ts:351-391`)

---

### Task B — Update `envConfig()` in `neo4j-sync.ts`

**File:** `src/commands/neo4j-sync.ts:23-36`

**Change:** Update `envConfig()` to fall back to `cfg.neo4j.uri/user/password/database` when env vars are missing:

```ts
function envConfig() {
  const cfg = loadProjectConfig();
  const uri = process.env[cfg.neo4j.uriEnv] || cfg.neo4j.uri;
  const username = process.env[cfg.neo4j.userEnv] || cfg.neo4j.user;
  const password = process.env[cfg.neo4j.passwordEnv] || cfg.neo4j.password;
  const database = process.env[cfg.neo4j.databaseEnv] || cfg.neo4j.database;
  const missing = [
    [cfg.neo4j.uriEnv, uri],
    [cfg.neo4j.userEnv, username],
    [cfg.neo4j.passwordEnv, password],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`Neo4j disabled: missing env vars ${missing.join(', ')}`);
  return { cfg, uri: uri ?? '', username: username ?? '', password: password ?? '', database };
}
```

**Behavioral cases:**
| # | Case | Expected |
|---|------|----------|
| B1 | Env vars set | priority: env vars win |
| B2 | Env vars missing but config.json has `neo4j.uri/user/password` | fallback works |
| B3 | Neither env nor config | throws error with missing list |

**TDD:** Update `src/commands/__tests__/neo4j-sync.test.ts` (or create if none) to test both paths.

---

### Task C — Update `writeMcpStanza()` in claude-bundle.ts to inject NEO4J env vars

**File:** `src/installers/claude-bundle.ts:382-389`

**Change:** After building the base env `{ PYTHON_BIN: venvPython() }`, if the project config has `graph_provider: "neo4j"` and credentials are available, add `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, `NEO4J_DATABASE`.

```ts
// After the base env block (line 385-388):
const configPath = id.configPath;
let projectCfg: ProjectConfig | null = null;
try {
  const { loadProjectConfig } = await import('../mcp-server/config.js');
  projectCfg = loadProjectConfig();
} catch { /* config may not exist yet during first init */ }

if (projectCfg?.graphProvider === 'neo4j') {
  const uri = process.env[projectCfg.neo4j.uriEnv] || projectCfg.neo4j.uri;
  const user = process.env[projectCfg.neo4j.userEnv] || projectCfg.neo4j.user;
  const password = process.env[projectCfg.neo4j.passwordEnv] || projectCfg.neo4j.password;
  const database = process.env[projectCfg.neo4j.databaseEnv] || projectCfg.neo4j.database;
  if (uri && user && password) {
    env.NEO4J_URI = uri;
    env.NEO4J_USERNAME = user;
    env.NEO4J_PASSWORD = password;
    if (database) env.NEO4J_DATABASE = database;
  }
}
```

**Behavioral cases:**
| # | Case | Expected |
|---|------|----------|
| B1 | `graph_provider: "neo4j"` + credentials in config.json | env vars added to `.mcp.json` |
| B2 | `graph_provider: "qdrant"` (default) | env block unchanged (only `PYTHON_BIN`) |
| B3 | Config doesn't exist yet (first `init`) | skip gracefully |
| B4 | `--force` re-run updates existing stanza | env vars updated |

**TDD:** Write `src/installers/__tests__/claude-bundle.test.ts` (or extend) testing env injection.

**Verbatim anchor:** The `existing` check at line 366 skips if stanza exists and `!force`. This is correct — the NEO4J env injection happens inside the stanza construction, so `--force` will re-write with current creds.

---

### Task D — Register `neo4j-setup` CLI command

**File:** `src/cli.ts:169-180`

**Changes:**
1. Add import: `import { runNeo4jSetup } from './commands/neo4j-setup.js';`
2. Register command after `neo4j-sync`:
   ```ts
   program
     .command('neo4j-setup')
     .description('Auto-detect, install, and configure Neo4j for graph backend. Sets up credentials in config.json and .mcp.json.')
     .option('--non-interactive', 'Skip prompts; use existing config or fail')
     .action(async (opts: { nonInteractive?: boolean }) => {
       try {
         await runNeo4jSetup({ nonInteractive: !!opts.nonInteractive });
       } catch (e) {
         fail(e);
       }
     });
   ```
3. Optionally add `--with-neo4j` flag to `init` / `add` commands that triggers `runNeo4jSetup` at end of install flow.

**Behavioral cases:** Same as Task A.

---

### Task E — Export `writeMcpStanza` and `deriveProjectIdentity`

**File:** `src/installers/claude-bundle.ts`

**Change:** Export `writeMcpStanza` function (currently un-exported, line 348) and re-export `deriveProjectIdentity` if needed for `neo4j-setup.ts`:

```ts
export async function writeMcpStanza(id: ProjectIdentity, force: boolean): Promise<void> {
```

Make sure `McpFile` and `McpServerEntry` interfaces are also exported if `neo4j-setup.ts` needs them (but likely it will just call `writeMcpStanza` which handles all MCP JSON logic).

---

### Task F — Update `README.md` Neo4j section

**File:** `README.md:227-235`

**Rewrite the section to cover:**

1. Auto-setup: `wide-researcher neo4j-setup` command
2. Manual config: direct credential fields in `.wide-researcher/config.json`
3. MCP env injection: running `wide-researcher init` / `wide-researcher add` re-generates `.mcp.json` with NEO4J_* env vars automatically if configured
4. Config.json credential format:
   ```json
   {
     "graph_provider": "neo4j",
     "neo4j": {
       "uri_env": "NEO4J_URI",
       "user_env": "NEO4J_USERNAME",
       "password_env": "NEO4J_PASSWORD",
       "database_env": "NEO4J_DATABASE",
       "uri": "bolt://127.0.0.1:7687",
       "user": "neo4j",
       "password": "your-password",
       "database": "neo4j"
     }
   }
   ```
5. Precendence: env var > config.json direct field
6. Syncing: `wide-researcher neo4j-sync`
7. Neo4j visualization guide (link to answer below)

**Verbatim anchor:** Lines 227-235 currently read:

> Qdrant remains the default graph provider. If you want exact graph traversal in Neo4j, set `graph_provider` to `neo4j`, provide `NEO4J_URI`, `NEO4J_USERNAME`, and `NEO4J_PASSWORD`, then run...

Replace entirely with expanded documentation.

---

### Task G — Bump version, commit, push, publish npm

**Version bump:** `package.json:22` `"version": "0.1.0-alpha.24"` → `"0.1.0-alpha.25"`

**Commit message template:**
```
feat: Neo4j auto-setup, MCP env injection, config.json credential fallback

- Add `wide-researcher neo4j-setup` command for auto-detection/install
- writeMcpStanza now injects NEO4J_* env vars when graph_provider=neo4j
- neo4j-sync envConfig() falls back to config.json direct credentials
- README: expanded Neo4j setup + config documentation
- Closes #...
```

**Steps:**
```bash
cd /var/www/wide-researcher
npm run build        # ensure clean compile
npm run lint         # ensure lint passes
npm run typecheck    # ensure types pass (if script exists)
git add -A
git commit -m "..."
git push origin main
npm publish --access public   # or without --access if already public
```

**Pre-publish checklist:**
- [ ] `npm run build` passes
- [ ] `npm test` passes (or `echo "no tests yet"`)
- [ ] `src/` changes are all committed
- [ ] `dist/` is regenerated (build output committed? check if `dist/` is in `.gitignore`)
- [ ] `package.json` version bumped
- [ ] `git push` succeeds before `npm publish`

---

## 3. Self-Audit Gate

Before committing the final diff, verify:

| Check | Command |
|-------|---------|
| TypeScript compiles | `npx tsc -p tsconfig.json --noEmit` |
| Lint passes | `npm run lint` |
| Neo4j MCP fallback works | Start MCP server without env vars → `wr_callers` succeeds |
| Installer produces correct `.mcp.json` | Run `node bin/wide-researcher.js init` in a temp dir → inspect `.mcp.json` |
| Synced data functional | `MATCH (s:Symbol) RETURN count(s)` in cypher-shell returns >0 |
| npm publish dry | `npm pack --dry-run` to verify file list |

---

## 4. Neo4j Graph Visualization (answer)

For your kraken project at `/var/www/kraken`, the graph is already populated. Here's how to visualize it:

### Option A: Neo4j Browser (recommended for exploration)

```bash
# Open in browser:
http://localhost:7474/browser/
```
Connect with: `bolt://127.0.0.1:7687`, user `neo4j`, password as set.

Try these queries:
```cypher
// All files
MATCH (f:File) RETURN f LIMIT 25

// All symbols + their files (graph view)
MATCH (f:File)-[:DECLARES]->(s:Symbol) RETURN f, s LIMIT 50

// Call graph: who calls "CreateAutomationModal"
MATCH (caller:Symbol)-[:CALLS]->(target:Name)
WHERE target.name CONTAINS "CreateAutomationModal"
RETURN caller, target LIMIT 20

// Top called functions
MATCH (s:Symbol)-[:CALLS]->(n:Name)
RETURN n.name, count(*) AS times_called
ORDER BY times_called DESC LIMIT 20

// Import graph for a file
MATCH (f:File {path: "/var/www/kraken/Dashboard/src/App.tsx"})-[:DECLARES]->(s:Symbol)
RETURN f, s LIMIT 30
```

### Option B: Neo4j Bloom (enterprise visual graph exploration)

```bash
# Open in browser:
http://localhost:7474/bloom/
```

### Option C: Cypher shell (CLI)

```bash
cypher-shell -a bolt://127.0.0.1:7687 -u neo4j
# then run any Cypher query interactively
```

### Useful visualization queries

```cypher
// ALL relationships from a single file (full dependency graph)
MATCH (f:File {path: "REPLACE_WITH_YOUR_FILE_PATH"})-[r]-(neighbor)
RETURN f, r, neighbor

// Find circular dependencies
MATCH (f1:File)-[:IMPORTS]->(f2:File)-[:IMPORTS]->(f1)
RETURN f1.path, f2.path

// Large component call graph
MATCH (s:Symbol)-[:CALLS]->(n:Name)
RETURN s.file_path, s.name, n.name LIMIT 100
```
