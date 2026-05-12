// Claude bundle installer: drops the agent + skill + MCP stanza into
// a project so Claude Code auto-discovers wide-researcher.
//
// What this installer creates / updates:
//
//   <project>/.wide-researcher/config.json
//       project_name, project_root, collection_name, qdrant_url,
//       model_path → the JSON pointed at by `WIDE_RESEARCHER_PROJECT_CONFIG`.
//
//   <project>/.claude/agents/wide-researcher.md
//       Copied verbatim from templates/claude/agents/.
//
//   <project>/.claude/skills/wide-research/SKILL.md
//   <project>/.claude/skills/wide-research/references/*.md
//       Copied verbatim from templates/claude/skills/wide-research/.
//
//   <project>/.mcp.json
//       Appended (or created) with the `wide-researcher` server stanza.
//       Existing entries are preserved.
//
// Project slug — deterministic + filename-safe:
//   <sanitised(basename)>_<sha1(abs-path)[0:8]>
// e.g. `myapp_a1b2c3d4`. Survives rename of the directory contents
// (slug stays the same if the absolute path stays the same).

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { log } from '../utils/log.js';
import { renderTemplate } from '../utils/template.js';
import {
  ensureDir,
  exists,
  miniLMPath,
  pyPackageRoot,
  projectClaudeDir,
  projectConfigDir,
  projectConfigPath,
  projectMcpPath,
  templatesRoot,
  venvPython,
} from '../utils/paths.js';

const MCP_SERVER_NAME = 'wide-researcher';

export interface ProjectIdentity {
  /** Cosmetic name (basename of the project dir). */
  projectName: string;
  /** Deterministic slug = `<sanitised>_<sha1[0:8]>`. Used for collection name + log files. */
  slug: string;
  /** Absolute path to the project root. */
  projectRoot: string;
  /** Absolute path to `<project>/.wide-researcher/config.json`. */
  configPath: string;
}

export function deriveProjectIdentity(cwd: string = process.cwd()): ProjectIdentity {
  const abs = path.resolve(cwd);
  const base = path.basename(abs.replace(/[/\\]+$/, '')) || 'project';
  const sanitised = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  const hash = createHash('sha1').update(abs).digest('hex').slice(0, 8);
  const slug = `${sanitised || 'project'}_${hash}`;
  return {
    projectName: base,
    slug,
    projectRoot: abs,
    configPath: projectConfigPath(cwd),
  };
}

/* ── config.json ────────────────────────────────────────────────────── */

export interface InstallBundleOptions {
  /** Project root. Defaults to cwd. */
  cwd?: string;
  /** Re-write files even if already present. */
  force?: boolean;
}

async function writeProjectConfig(id: ProjectIdentity, force: boolean): Promise<void> {
  const cfgDir = projectConfigDir(id.projectRoot);
  await ensureDir(cfgDir);

  const cfg = {
    project_name: id.projectName,
    project_root: id.projectRoot,
    collection_name: id.slug,
    qdrant_url: 'http://127.0.0.1:6333',
    model_path: miniLMPath(),
    embed_model: 'sentence-transformers/all-MiniLM-L6-v2',
    embed_dim: 384,
    batch_size: 16,
    max_file_bytes: 64 * 1024,
  };

  if (!force && (await exists(id.configPath))) {
    log.skip(`project config already exists at ${id.configPath}`);
    return;
  }
  await fs.writeFile(id.configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  log.ok(`wrote ${id.configPath}`);
}

/* ── .claude/ tree ──────────────────────────────────────────────────── */

async function copyFile(src: string, dst: string, force: boolean): Promise<boolean> {
  if (!force && (await exists(dst))) {
    log.skip(`already present: ${dst}`);
    return false;
  }
  await ensureDir(path.dirname(dst));
  await fs.copyFile(src, dst);
  log.ok(`wrote ${dst}`);
  return true;
}

async function copyDir(srcDir: string, dstDir: string, force: boolean): Promise<void> {
  await ensureDir(dstDir);
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      await copyDir(src, dst, force);
    } else if (entry.isFile()) {
      await copyFile(src, dst, force);
    }
  }
}

async function writeClaudeBundle(id: ProjectIdentity, force: boolean): Promise<void> {
  const claudeDir = projectClaudeDir(id.projectRoot);
  await ensureDir(path.join(claudeDir, 'agents'));
  await ensureDir(path.join(claudeDir, 'skills', 'wide-research'));

  const tplAgents = path.join(templatesRoot(), 'claude', 'agents');
  const tplSkill = path.join(templatesRoot(), 'claude', 'skills', 'wide-research');

  await copyFile(
    path.join(tplAgents, 'wide-researcher.md'),
    path.join(claudeDir, 'agents', 'wide-researcher.md'),
    force,
  );
  await copyDir(tplSkill, path.join(claudeDir, 'skills', 'wide-research'), force);
}

/* ── auto-run hook (UserPromptSubmit) ──────────────────────────────── */

const HOOK_MARKER = '<!-- wide-researcher-hook -->';

async function writeHookScript(id: ProjectIdentity, force: boolean): Promise<string> {
  const hookDir = path.join(projectConfigDir(id.projectRoot), 'hooks');
  await ensureDir(hookDir);
  const dst = path.join(hookDir, 'wide_research_hook.py');
  if (!force && (await exists(dst))) {
    log.skip(`hook script already present at ${dst}`);
    return dst;
  }
  const tpl = path.join(templatesRoot(), 'hooks', 'wide_research_hook.py.tpl');
  const rendered = await renderTemplate(tpl, {
    VENV_PYTHON: venvPython(),
    PY_ROOT: pyPackageRoot(),
    PROJECT_CONFIG: id.configPath,
  });
  await fs.writeFile(dst, rendered, 'utf8');
  // Make executable on POSIX — harmless on Windows.
  try {
    await fs.chmod(dst, 0o755);
  } catch {
    /* ignore on Windows */
  }
  log.ok(`wrote ${dst}`);
  return dst;
}

interface ClaudeSettingsHooks {
  hooks?: {
    UserPromptSubmit?: Array<{
      matcher?: string;
      hooks?: Array<{
        type?: string;
        command?: string;
        timeout?: number;
        statusMessage?: string;
        _wr?: typeof HOOK_MARKER;
      }>;
    }>;
  };
  [k: string]: unknown;
}

async function registerClaudeHook(id: ProjectIdentity, hookScriptPath: string): Promise<void> {
  const settingsPath = path.join(projectClaudeDir(id.projectRoot), 'settings.local.json');
  let doc: ClaudeSettingsHooks = {};
  if (await exists(settingsPath)) {
    try {
      const raw = await fs.readFile(settingsPath, 'utf8');
      doc = JSON.parse(raw) as ClaudeSettingsHooks;
      if (!doc || typeof doc !== 'object') doc = {};
    } catch (e) {
      throw new Error(
        `Existing ${settingsPath} is not valid JSON: ${(e as Error).message}. ` +
          `Fix by hand or delete it and re-run.`,
      );
    }
  }
  doc.hooks ??= {};
  doc.hooks.UserPromptSubmit ??= [];

  // Strip any prior wide-researcher hook entry (idempotent).
  doc.hooks.UserPromptSubmit = doc.hooks.UserPromptSubmit
    .map((group) => {
      const inner = (group.hooks ?? []).filter((h) => h._wr !== HOOK_MARKER);
      return { ...group, hooks: inner };
    })
    .filter((group) => (group.hooks ?? []).length > 0);

  // Cross-platform invocation — `python3` on POSIX, `python` on Windows.
  // The Python file is shebang'd but Windows ignores that; use explicit
  // interpreter for portability.
  const command =
    process.platform === 'win32'
      ? `python "${hookScriptPath}"`
      : `python3 "${hookScriptPath}"`;

  doc.hooks.UserPromptSubmit.push({
    matcher: '*',
    hooks: [
      {
        type: 'command',
        command,
        timeout: 30,
        statusMessage: 'Mapping impact radius (qdrant + MiniLM-L6)…',
        _wr: HOOK_MARKER,
      },
    ],
  });

  await ensureDir(path.dirname(settingsPath));
  await fs.writeFile(settingsPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  log.ok(`registered UserPromptSubmit hook in ${settingsPath}`);
}

/* ── .mcp.json stanza ───────────────────────────────────────────────── */

interface McpFile {
  mcpServers?: Record<string, McpServerEntry>;
}

interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

async function writeMcpStanza(id: ProjectIdentity, force: boolean): Promise<void> {
  const mcpPath = projectMcpPath(id.projectRoot);
  let doc: McpFile = {};
  if (await exists(mcpPath)) {
    try {
      const raw = await fs.readFile(mcpPath, 'utf8');
      doc = JSON.parse(raw) as McpFile;
      if (!doc || typeof doc !== 'object') doc = {};
    } catch (e) {
      throw new Error(
        `Existing ${mcpPath} is not valid JSON: ${(e as Error).message}. ` +
          `Fix the file by hand or delete it and re-run.`,
      );
    }
  }
  doc.mcpServers ??= {};

  const existing = doc.mcpServers[MCP_SERVER_NAME];
  if (existing && !force) {
    log.skip(`MCP stanza ${MCP_SERVER_NAME} already present in ${mcpPath}`);
    return;
  }

  // The MCP server is a bin script shipped with the npm package. We resolve
  // it to an absolute path so the stanza keeps working regardless of cwd.
  // Two equally valid resolutions: bundled bin (preferred if installed
  // globally / via npx) and a fall-back path for local development.
  const bundledBin = path.resolve(
    pyPackageRoot(),
    '..',
    'bin',
    'wide-researcher-mcp.js',
  );

  doc.mcpServers[MCP_SERVER_NAME] = {
    command: 'node',
    args: [bundledBin, '--project-config', id.configPath],
    env: {
      // Python venv that hosts the embed worker model cache.
      PYTHON_BIN: venvPython(),
    },
  };

  await fs.writeFile(mcpPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  log.ok(`updated ${mcpPath} → mcpServers.${MCP_SERVER_NAME}`);
}

/* ── public entry ───────────────────────────────────────────────────── */

export async function installClaudeBundle(
  opts: InstallBundleOptions = {},
): Promise<ProjectIdentity> {
  const id = deriveProjectIdentity(opts.cwd);
  const force = !!opts.force;

  log.step(`project=${id.projectName} slug=${id.slug}`);
  await writeProjectConfig(id, force);
  await writeClaudeBundle(id, force);
  await writeMcpStanza(id, force);
  const hookScriptPath = await writeHookScript(id, force);
  await registerClaudeHook(id, hookScriptPath);
  log.ok(`claude bundle installed for ${id.projectName}`);
  return id;
}

export async function uninstallClaudeBundle(
  opts: InstallBundleOptions = {},
): Promise<void> {
  const id = deriveProjectIdentity(opts.cwd);
  const mcpPath = projectMcpPath(id.projectRoot);

  if (await exists(mcpPath)) {
    try {
      const raw = await fs.readFile(mcpPath, 'utf8');
      const doc = JSON.parse(raw) as McpFile;
      if (doc?.mcpServers?.[MCP_SERVER_NAME]) {
        delete doc.mcpServers[MCP_SERVER_NAME];
        await fs.writeFile(mcpPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
        log.ok(`removed mcpServers.${MCP_SERVER_NAME} from ${mcpPath}`);
      }
    } catch {
      // ignore malformed mcp.json
    }
  }

  // Strip the wide-researcher hook entry from settings.local.json
  const settingsPath = path.join(projectClaudeDir(id.projectRoot), 'settings.local.json');
  if (await exists(settingsPath)) {
    try {
      const raw = await fs.readFile(settingsPath, 'utf8');
      const doc = JSON.parse(raw) as ClaudeSettingsHooks;
      if (doc?.hooks?.UserPromptSubmit) {
        doc.hooks.UserPromptSubmit = doc.hooks.UserPromptSubmit
          .map((group) => {
            const inner = (group.hooks ?? []).filter((h) => h._wr !== HOOK_MARKER);
            return { ...group, hooks: inner };
          })
          .filter((group) => (group.hooks ?? []).length > 0);
        await fs.writeFile(settingsPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
        log.ok(`removed wide-researcher hook from ${settingsPath}`);
      }
    } catch {
      // ignore malformed settings.local.json
    }
  }

  const filesToRemove = [
    path.join(projectClaudeDir(id.projectRoot), 'agents', 'wide-researcher.md'),
    path.join(projectClaudeDir(id.projectRoot), 'skills', 'wide-research'),
    projectConfigDir(id.projectRoot),
  ];
  for (const target of filesToRemove) {
    if (await exists(target)) {
      await fs.rm(target, { recursive: true, force: true });
      log.ok(`removed ${target}`);
    }
  }
}
