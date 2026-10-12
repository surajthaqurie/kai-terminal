import fs from "fs";
import os from "os";
import path from "path";

/**
 * Single source of truth for every external AI agent Kai can wire up.
 *
 * Previously the setup list (CLI `agent setup`), the PATH detection
 * catalog (Rust `ai_cli.rs`) and the UI fallback list each hardcoded
 * their own subset, which is why `opencode` was detected as installed
 * but `kai agent setup opencode` reported "unknown agent".
 *
 * All entries here are dynamic by default: `detectInstalledAgentsSync()`
 * probes the live system PATH + known config files at runtime, so newly
 * installed agents are picked up without code changes.
 */

export type AgentKind = "cli" | "ide";

/** How the kai MCP entry is stored in an agent's config file. */
export type AgentConfigKeyStyle =
  "mcpServers" | "mcp-opencode" | "mcp_servers" | "vscode-servers" | "toml-codex";

export interface AgentConfigTarget {
  scope: "global" | "project";
  /**
   * Home-relative path (global) or project-relative path (project) of the
   * config file Kai writes. `~` expansion and absolute paths are never
   * accepted here — registry values only.
   */
  relPath: string;
  keyStyle: AgentConfigKeyStyle;
  /**
   * Home-relative directory that must already exist before Kai creates the
   * file (e.g. VS Code's storage dir for Cline). When set and missing, auto
   * setup reports manual steps instead of fabricating app directories.
   */
  requireAppDir?: string;
}

export interface AgentDefinition {
  /** Stable id used on the CLI (`kai agent setup <id>`) and in detection. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** `cli` = terminal binary on PATH, `ide` = editor/extension driven. */
  kind: AgentKind;
  /** Binary names probed on PATH (first hit wins). Empty for pure IDE agents. */
  binaries: string[];
  /** Extra spellings accepted by `kai agent setup` (e.g. `vscode` → copilot). */
  aliases: string[];
  /** Display hint for where the generated snippet goes. */
  configFile: string;
  /** Home-relative config paths treated as "configured" evidence. */
  configPaths: string[];
  /** Install guidance shown when the agent is missing. */
  installGuidance: string;
  /** Machine-readable config file(s) Kai can write automatically. */
  targets: AgentConfigTarget[];
  /** Project-directory argument baked into the kai MCP entry. */
  projectArg?: string;
  /** Build the verified MCP snippet. `kaiBin` is JSON-escaped by callers. */
  buildSetup: (kaiBin: string) => string;
}

/**
 * Cline stores MCP settings inside VS Code's global storage, whose location
 * is platform-specific. Resolved once at module load; never user-controlled.
 */
function clineGlobalTarget(): AgentConfigTarget {
  if (process.platform === "darwin") {
    return {
      scope: "global",
      relPath:
        "Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json",
      keyStyle: "mcpServers",
      requireAppDir: "Library/Application Support/Code",
    };
  }
  if (process.platform === "win32") {
    return {
      scope: "global",
      relPath:
        "AppData/Roaming/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json",
      keyStyle: "mcpServers",
      requireAppDir: "AppData/Roaming/Code",
    };
  }
  return {
    scope: "global",
    relPath:
      ".config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json",
    keyStyle: "mcpServers",
    requireAppDir: ".config/Code",
  };
}

export const AGENT_REGISTRY: AgentDefinition[] = [
  {
    id: "claude",
    name: "Claude Code",
    kind: "cli",
    binaries: ["claude"],
    aliases: [],
    configFile: "~/.claude.json",
    configPaths: [".claude.json", ".config/claude-code"],
    installGuidance:
      "Install via npm: npm install -g @anthropic-ai/claude-code — docs: https://docs.anthropic.com/en/docs/claude-code",
    targets: [{ scope: "global", relPath: ".claude.json", keyStyle: "mcpServers" }],
    buildSetup: (kaiBin: string) => {
      const quotedBin = JSON.stringify(kaiBin);
      return `
Verified Claude Code MCP Configuration:
Add the following to your Claude Code settings (e.g., ~/.claude.json or project config):

{
  "mcpServers": {
    "kai": {
      "command": "node",
      "args": [${quotedBin}, "mcp", "."]
    }
  }
}

Verification:
Run: claude
In chat: "Use kai_project_info to inspect the codebase."
`;
    },
  },
  {
    id: "cursor",
    name: "Cursor",
    kind: "ide",
    binaries: ["cursor", "cursor-cli"],
    aliases: [],
    configFile: ".cursor/mcp.json",
    configPaths: [".cursor/mcp.json", ".cursor-server"],
    installGuidance:
      "Install Cursor from https://cursor.com — MCP docs: https://docs.cursor.com/mcp",
    targets: [
      { scope: "global", relPath: ".cursor/mcp.json", keyStyle: "mcpServers" },
      { scope: "project", relPath: ".cursor/mcp.json", keyStyle: "mcpServers" },
    ],
    projectArg: "${workspaceFolder}",
    buildSetup: (kaiBin: string) => {
      const quotedBin = JSON.stringify(kaiBin);
      return `
Verified Cursor MCP Configuration:
Add to .cursor/mcp.json or Cursor Settings > MCP:

{
  "mcpServers": {
    "kai": {
      "command": "node",
      "args": [${quotedBin}, "mcp", "\${workspaceFolder}"]
    }
  }
}
`;
    },
  },
  {
    id: "codex",
    name: "Codex CLI",
    kind: "cli",
    binaries: ["codex"],
    aliases: [],
    configFile: "~/.codex/config.toml",
    configPaths: [".codex", ".config/codex"],
    installGuidance:
      "Install via npm: npm install -g @openai/codex — docs: https://github.com/openai/codex",
    targets: [{ scope: "global", relPath: ".codex/config.toml", keyStyle: "toml-codex" }],
    buildSetup: (kaiBin: string) => {
      const quotedBin = JSON.stringify(kaiBin);
      return `
Verified OpenAI Codex / CLI Agent Configuration:
Launch Codex with MCP stdio configuration pointing to Kai:

{
  "mcp_servers": [
    {
      "name": "kai",
      "command": "node",
      "args": [${quotedBin}, "mcp", "."]
    }
  ]
}
`;
    },
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    kind: "cli",
    binaries: ["gemini", "gemini-cli"],
    aliases: [],
    configFile: "~/.muse/settings.json",
    configPaths: [".gemini", ".config/gemini-cli"],
    installGuidance:
      "Install via npm: npm install -g @google/gemini-cli — docs: https://github.com/google-gemini/gemini-cli",
    targets: [{ scope: "global", relPath: ".muse/settings.json", keyStyle: "mcpServers" }],
    buildSetup: (kaiBin: string) => {
      const quotedBin = JSON.stringify(kaiBin);
      return `
Verified Gemini CLI MCP Configuration:
Add to ~/.muse/settings.json (or .muse/settings.json for project scope):

{
  "mcpServers": {
    "kai": {
      "command": "node",
      "args": [${quotedBin}, "mcp", "."]
    }
  }
}

Verification:
Run: gemini
In chat: "Use kai_project_info to inspect the codebase."
`;
    },
  },
  {
    id: "copilot",
    name: "Muse CLI",
    kind: "cli",
    binaries: ["copilot", "gh-copilot"],
    aliases: ["vscode"],
    configFile: ".vscode/mcp.json",
    configPaths: [".config/github-copilot", ".copilot"],
    installGuidance:
      "Install via npm: npm install -g @github/copilot — docs: https://docs.github.com/en/copilot",
    targets: [{ scope: "project", relPath: ".vscode/mcp.json", keyStyle: "vscode-servers" }],
    buildSetup: (kaiBin: string) => {
      const quotedBin = JSON.stringify(kaiBin);
      return `
Verified VS Code / Copilot MCP Configuration:
Add to .vscode/mcp.json:

{
  "servers": {
    "kai": {
      "type": "stdio",
      "command": "node",
      "args": [${quotedBin}, "mcp", "."]
    }
  }
}

Verification:
Open VS Code MCP settings and confirm the "kai" server is running.
`;
    },
  },
  {
    id: "windsurf",
    name: "Windsurf",
    kind: "ide",
    binaries: ["windsurf"],
    aliases: ["codeium"],
    configFile: "~/.codeium/windsurf/mcp_config.json",
    configPaths: [".codeium/windsurf/mcp_config.json", ".windsurf"],
    installGuidance:
      "Install Windsurf from https://windsurf.com — MCP docs: https://docs.windsurf.com",
    targets: [
      {
        scope: "global",
        relPath: ".codeium/windsurf/mcp_config.json",
        keyStyle: "mcpServers",
      },
    ],
    buildSetup: (kaiBin: string) => {
      const quotedBin = JSON.stringify(kaiBin);
      return `
Verified Windsurf MCP Configuration:
Add to ~/.codeium/windsurf/mcp_config.json:

{
  "mcpServers": {
    "kai": {
      "command": "node",
      "args": [${quotedBin}, "mcp", "."]
    }
  }
}

Verification:
Restart Windsurf and confirm the "kai" MCP server is connected.
`;
    },
  },
  {
    id: "cline",
    name: "Cline",
    kind: "ide",
    binaries: ["cline"],
    aliases: [],
    configFile: "cline_mcp_settings.json",
    configPaths: [".config/cline", ".vscode/cline_mcp_settings.json"],
    installGuidance: "Install the Cline VS Code extension — docs: https://docs.cline.bot/mcp",
    targets: [clineGlobalTarget()],
    buildSetup: (kaiBin: string) => {
      const quotedBin = JSON.stringify(kaiBin);
      return `
Verified Cline MCP Configuration:
Add to cline_mcp_settings.json (VS Code Cline extension settings):

{
  "mcpServers": {
    "kai": {
      "command": "node",
      "args": [${quotedBin}, "mcp", "."]
    }
  }
}

Verification:
Open the Cline MCP settings panel and confirm the "kai" server is listed.
`;
    },
  },
  {
    id: "opencode",
    name: "opencode",
    kind: "cli",
    binaries: ["opencode", "opencode-ai"],
    aliases: ["open-code", "opencode.ai"],
    configFile: "~/.config/opencode/opencode.json",
    configPaths: [".config/opencode", ".opencode"],
    installGuidance: "Install via npm: npm install -g opencode-ai — docs: https://opencode.ai/docs",
    targets: [
      { scope: "global", relPath: ".config/opencode/opencode.json", keyStyle: "mcp-opencode" },
    ],
    buildSetup: (kaiBin: string) => {
      const quotedBin = JSON.stringify(kaiBin);
      const command = JSON.stringify(["node", kaiBin, "mcp", "."]);
      return `
Verified opencode MCP Configuration:
Add to ~/.config/opencode/opencode.json (global) or opencode.json in the project root:

{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "kai": {
      "type": "local",
      "command": ${command},
      "enabled": true
    }
  }
}

Notes:
- opencode uses the "mcp" key (not "mcpServers"); command is a single array.
- kaiBin resolves to: ${quotedBin}

Verification:
Run: opencode
In chat: "Use kai_project_info to inspect the codebase."
`;
    },
  },
  {
    id: "aider",
    name: "Aider",
    kind: "cli",
    binaries: ["aider", "aider-chat"],
    aliases: [],
    configFile: "~/.config/aider/mcp.json",
    configPaths: [".config/aider", ".aider.conf.yml", ".aider.model.settings.yml"],
    installGuidance:
      "Install via pip: pip install aider-chat — docs: https://aider.chat/docs/install.html",
    targets: [{ scope: "global", relPath: ".config/aider/mcp.json", keyStyle: "mcpServers" }],
    buildSetup: (kaiBin: string) => {
      const quotedBin = JSON.stringify(kaiBin);
      return `
Verified Aider MCP Configuration:
Aider reads MCP servers from ~/.config/aider/mcp.json (Claude Desktop convention):

{
  "mcpServers": {
    "kai": {
      "command": "node",
      "args": [${quotedBin}, "mcp", "."]
    }
  }
}

Verification:
Run: aider
Confirm the "kai" MCP tools are listed at session start.
`;
    },
  },
];

/** Ordered ids, e.g. for help output and `SUPPORTED_AGENTS` compat. */
export function listAgentIds(): string[] {
  return AGENT_REGISTRY.map((a) => a.id);
}

export function getAgentDefinition(id: string): AgentDefinition | null {
  const normalized = id.toLowerCase().trim();
  for (const def of AGENT_REGISTRY) {
    if (def.id === normalized || def.aliases.includes(normalized)) return def;
  }
  return null;
}

/**
 * Build the verified MCP configuration snippet for an external agent.
 * Pure function (takes kaiBin explicitly) so Windows-style paths can be
 * unit-tested on any OS. Unknown ids return null.
 */
export function buildAgentSetup(agent: string, kaiBin: string): string | null {
  const def = getAgentDefinition(agent);
  if (!def) return null;
  return def.buildSetup(kaiBin);
}

// ---------------------------------------------------------------------------
// Dynamic system detection (PATH + config presence, no execution)
// ---------------------------------------------------------------------------

function findBinaryOnPath(bin: string): string | null {
  if (!/^[a-zA-Z0-9_.-]+$/.test(bin)) return null;
  const envPath = process.env.PATH || process.env.Path || "";
  const isWindows = process.platform === "win32";
  const exts = isWindows
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").map((e) => e.toLowerCase())
    : [""];
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const name = isWindows && bin.toLowerCase().endsWith(ext) ? bin : bin + ext;
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // ignore
      }
    }
  }
  return null;
}

export interface DetectedAgent {
  id: string;
  name: string;
  kind: AgentKind;
  /** True when any of the agent's binaries is found on PATH. */
  binaryFound: boolean;
  binaryPath: string | null;
  /** True when a known config file/dir exists under $HOME. */
  configured: boolean;
  /** True when the agent's config already contains a kai MCP entry. */
  kaiWired: boolean;
  configFile: string;
  installGuidance: string;
}

export interface AgentDetectionOptions {
  homeDir?: string;
  /** Project dir used for project-scoped wiring checks (defaults to cwd). */
  projectDir?: string;
}

/**
 * Probe the live system for every registered agent.
 * Never executes third-party binaries; only stats PATH entries and
 * home-relative config paths. Safe to call on every `kai agent list`.
 */
export function detectInstalledAgentsSync(opts?: AgentDetectionOptions | string): DetectedAgent[] {
  const home = typeof opts === "string" ? opts : opts?.homeDir || os.homedir();
  const projectDir = (typeof opts === "object" && opts?.projectDir) || process.cwd();
  return AGENT_REGISTRY.map((def) => {
    let binaryPath: string | null = null;
    for (const bin of def.binaries) {
      const found = findBinaryOnPath(bin);
      if (found) {
        binaryPath = found;
        break;
      }
    }
    let configured = false;
    for (const rel of def.configPaths) {
      try {
        if (fs.existsSync(path.join(home, rel))) {
          configured = true;
          break;
        }
      } catch {
        // ignore
      }
    }
    return {
      id: def.id,
      name: def.name,
      kind: def.kind,
      binaryFound: binaryPath !== null,
      binaryPath,
      configured,
      kaiWired: isAgentWired(def.id, { homeDir: home, projectDir }),
      configFile: def.configFile,
      installGuidance: def.installGuidance,
    };
  });
}

// ---------------------------------------------------------------------------
// Automatic MCP wiring (safe file merge, never destructive)
// ---------------------------------------------------------------------------

/** Refuse to parse agent configs larger than this (protects against OOM). */
const MAX_CONFIG_BYTES = 1024 * 1024;

export interface AgentSetupOptions {
  homeDir?: string;
  projectDir?: string;
  /** "auto" prefers the global target, falling back to project. */
  scope?: "auto" | "global" | "project";
  /** Overwrite the kai entry when it already exists (e.g. kai moved). */
  force?: boolean;
  /** Preview only: compute the result without touching the filesystem. */
  dryRun?: boolean;
}

export interface AgentSetupResult {
  id: string;
  name: string;
  /** Absolute config file path (or "" when no writable target exists). */
  path: string;
  scope: "global" | "project" | "none";
  wrote: boolean;
  created: boolean;
  alreadyConfigured: boolean;
  skipped: boolean;
  backupPath: string | null;
  message: string;
}

/** Build the kai MCP entry object for a JSON-style agent config. */
export function buildKaiMcpEntry(def: AgentDefinition, kaiBin: string): Record<string, unknown> {
  const projectArg = def.projectArg || ".";
  switch (def.targets[0]?.keyStyle) {
    case "mcp-opencode":
      return {
        type: "local",
        command: ["node", kaiBin, "mcp", projectArg],
        enabled: true,
      };
    case "vscode-servers":
      return {
        type: "stdio",
        command: "node",
        args: [kaiBin, "mcp", projectArg],
      };
    default:
      return { command: "node", args: [kaiBin, "mcp", projectArg] };
  }
}

/**
 * Resolve the writable config file for an agent.
 * Returns an error message when no target applies (e.g. Cline without
 * VS Code installed) so callers can print manual steps instead of
 * fabricating foreign app directories.
 */
export function resolveAgentConfigPath(
  def: AgentDefinition,
  opts: AgentSetupOptions = {}
): { path: string; target: AgentConfigTarget } | { error: string } {
  const home = opts.homeDir || os.homedir();
  const projectDir = opts.projectDir || process.cwd();
  const wanted = opts.scope || "auto";
  const candidates = def.targets.filter((t) => wanted === "auto" || t.scope === wanted);
  // Auto scope prefers global targets first, then project ones.
  const ordered = [...candidates].sort((a, b) =>
    wanted === "auto" && a.scope !== b.scope ? (a.scope === "global" ? -1 : 1) : 0
  );
  for (const target of ordered) {
    if (target.requireAppDir) {
      try {
        if (!fs.existsSync(path.join(home, target.requireAppDir))) continue;
      } catch {
        continue;
      }
    }
    const base = target.scope === "global" ? home : projectDir;
    return { path: path.join(base, target.relPath), target };
  }
  if (candidates.length === 0) {
    return { error: `No ${wanted}-scope config target is defined for "${def.id}".` };
  }
  return {
    error:
      `"${def.name}" does not look installed here (required app directory ` +
      `is missing), so Kai left its files untouched. ${def.installGuidance}`,
  };
}

function readJsonConfig(filePath: string): {
  exists: boolean;
  data: Record<string, unknown>;
  parseError: string | null;
} {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return { exists: false, data: {}, parseError: null };
  }
  if (Buffer.byteLength(raw, "utf-8") > MAX_CONFIG_BYTES) {
    return {
      exists: true,
      data: {},
      parseError: `Config file exceeds ${MAX_CONFIG_BYTES} bytes; merge it manually.`,
    };
  }
  const trimmed = raw.trim();
  if (!trimmed) return { exists: true, data: {}, parseError: null };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { exists: true, data: parsed as Record<string, unknown>, parseError: null };
    }
    return {
      exists: true,
      data: {},
      parseError: "Config file does not contain a JSON object; merge it manually.",
    };
  } catch {
    return {
      exists: true,
      data: {},
      parseError: "Config file is not valid JSON; merge it manually to avoid data loss.",
    };
  }
}

/** Insert (or refresh with force) the kai entry inside a parsed JSON config. */
export function mergeKaiMcpEntry(
  data: Record<string, unknown>,
  keyStyle: AgentConfigKeyStyle,
  kaiBin: string,
  projectArg: string,
  force: boolean
): { alreadyConfigured: boolean } {
  const entry: Record<string, unknown> =
    keyStyle === "mcp-opencode"
      ? { type: "local", command: ["node", kaiBin, "mcp", projectArg], enabled: true }
      : keyStyle === "vscode-servers"
        ? { type: "stdio", command: "node", args: [kaiBin, "mcp", projectArg] }
        : { command: "node", args: [kaiBin, "mcp", projectArg] };
  const containerKey =
    keyStyle === "mcp-opencode"
      ? "mcp"
      : keyStyle === "mcp_servers"
        ? "mcp_servers"
        : keyStyle === "vscode-servers"
          ? "servers"
          : "mcpServers";
  let container = data[containerKey];
  if (!container || typeof container !== "object" || Array.isArray(container)) {
    container = {};
    data[containerKey] = container;
  }
  const servers = container as Record<string, unknown>;
  if (servers.kai !== undefined && !force) return { alreadyConfigured: true };
  servers.kai = entry;
  return { alreadyConfigured: false };
}

function hasKaiJsonEntry(data: Record<string, unknown>): boolean {
  for (const key of ["mcpServers", "mcp", "mcp_servers", "servers"]) {
    const container = data[key];
    if (
      container &&
      typeof container === "object" &&
      !Array.isArray(container) &&
      (container as Record<string, unknown>).kai !== undefined
    ) {
      return true;
    }
  }
  return false;
}

const CODEX_TOML_SECTION = "mcp_servers.kai";

function buildCodexTomlSection(kaiBin: string, projectArg: string): string {
  const args = JSON.stringify([kaiBin, "mcp", projectArg]);
  return `[${CODEX_TOML_SECTION}]\ncommand = "node"\nargs = ${args}\n`;
}

/** Idempotent text append for Codex's TOML config (no TOML parser needed). */
function applyCodexTomlSetup(
  filePath: string,
  kaiBin: string,
  projectArg: string,
  force: boolean,
  dryRun: boolean
): Omit<AgentSetupResult, "id" | "name" | "path" | "scope"> {
  let existing = "";
  let fileExists = false;
  try {
    existing = fs.readFileSync(filePath, "utf-8");
    fileExists = true;
  } catch {
    fileExists = false;
  }
  const hasKai =
    existing.includes(`[${CODEX_TOML_SECTION}]`) || existing.includes(`${CODEX_TOML_SECTION}.`);
  if (hasKai && !force) {
    return {
      wrote: false,
      created: false,
      alreadyConfigured: true,
      skipped: false,
      backupPath: null,
      message: `Kai entry already present in ${filePath}.`,
    };
  }
  if (dryRun) {
    return {
      wrote: false,
      created: !fileExists,
      alreadyConfigured: false,
      skipped: false,
      backupPath: null,
      message: `Would ${fileExists ? "append kai section to" : "create"} ${filePath}.`,
    };
  }
  ensureParentDir(filePath);
  let backupPath: string | null = null;
  if (fileExists) backupPath = backupFile(filePath);
  const section = buildCodexTomlSection(kaiBin, projectArg);
  const next =
    !fileExists || !existing.endsWith("\n")
      ? `${existing}${fileExists ? "\n" : ""}\n${section}`
      : `${existing}\n${section}`;
  atomicWriteFile(filePath, fileExists ? next : `${section}`);
  return {
    wrote: true,
    created: !fileExists,
    alreadyConfigured: false,
    skipped: false,
    backupPath,
    message: `Wrote kai MCP section to ${filePath}.`,
  };
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
}

/** Copy the previous file next to itself before overwriting; never throws. */
function backupFile(filePath: string): string | null {
  try {
    const backupPath = `${filePath}.kai.bak`;
    fs.copyFileSync(filePath, backupPath);
    return backupPath;
  } catch {
    return null;
  }
}

/** Write via temp file + rename so interrupted runs never leave halves. */
function atomicWriteFile(filePath: string, content: string): void {
  const tmpPath = `${filePath}.kai.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, content, { mode: 0o600, encoding: "utf-8" });
  fs.renameSync(tmpPath, filePath);
}

/**
 * Check whether an agent's default config already wires the kai MCP entry.
 * Pure read-only probe used by `kai agent list` and the desktop panel.
 */
export function isAgentWired(agent: string, opts: AgentSetupOptions = {}): boolean {
  const def = getAgentDefinition(agent);
  if (!def) return false;
  const resolved = resolveAgentConfigPath(def, { ...opts, scope: opts.scope || "auto" });
  if ("error" in resolved) return false;
  if (resolved.target.keyStyle === "toml-codex") {
    try {
      const raw = fs.readFileSync(resolved.path, "utf-8");
      return raw.includes(`[${CODEX_TOML_SECTION}]`) || raw.includes(`${CODEX_TOML_SECTION}.`);
    } catch {
      return false;
    }
  }
  const { exists, data, parseError } = readJsonConfig(resolved.path);
  if (!exists || parseError) return false;
  return hasKaiJsonEntry(data);
}

/**
 * Automatically install kai MCP wiring for one agent: resolves the config
 * file for this system, merges the kai entry (creating the file when
 * needed), keeps a `.kai.bak` backup, and never touches unrelated keys.
 */
export function applyAgentSetup(
  agent: string,
  kaiBin: string,
  opts: AgentSetupOptions = {}
): AgentSetupResult {
  const def = getAgentDefinition(agent);
  if (!def) {
    return {
      id: agent,
      name: agent,
      path: "",
      scope: "none",
      wrote: false,
      created: false,
      alreadyConfigured: false,
      skipped: true,
      backupPath: null,
      message: `Unknown agent "${agent}". Run 'kai agent list' for targets.`,
    };
  }
  if (!kaiBin || kaiBin.length > 4096 || kaiBin.includes("\0")) {
    return {
      id: def.id,
      name: def.name,
      path: "",
      scope: "none",
      wrote: false,
      created: false,
      alreadyConfigured: false,
      skipped: true,
      backupPath: null,
      message: "Refusing to write: kai binary path is invalid.",
    };
  }
  const resolved = resolveAgentConfigPath(def, opts);
  if ("error" in resolved) {
    return {
      id: def.id,
      name: def.name,
      path: "",
      scope: "none",
      wrote: false,
      created: false,
      alreadyConfigured: false,
      skipped: true,
      backupPath: null,
      message: resolved.error,
    };
  }
  const { path: filePath, target } = resolved;
  const projectArg = def.projectArg || ".";
  const dryRun = opts.dryRun === true;
  const force = opts.force === true;

  if (target.keyStyle === "toml-codex") {
    const r = applyCodexTomlSetup(filePath, kaiBin, projectArg, force, dryRun);
    return { id: def.id, name: def.name, path: filePath, scope: target.scope, ...r };
  }

  const { exists, data, parseError } = readJsonConfig(filePath);
  if (parseError) {
    return {
      id: def.id,
      name: def.name,
      path: filePath,
      scope: target.scope,
      wrote: false,
      created: false,
      alreadyConfigured: false,
      skipped: true,
      backupPath: null,
      message: `${filePath}: ${parseError}`,
    };
  }
  const { alreadyConfigured } = mergeKaiMcpEntry(data, target.keyStyle, kaiBin, projectArg, force);
  if (alreadyConfigured) {
    return {
      id: def.id,
      name: def.name,
      path: filePath,
      scope: target.scope,
      wrote: false,
      created: false,
      alreadyConfigured: true,
      skipped: false,
      backupPath: null,
      message: `Kai entry already present in ${filePath}.`,
    };
  }
  if (dryRun) {
    return {
      id: def.id,
      name: def.name,
      path: filePath,
      scope: target.scope,
      wrote: false,
      created: !exists,
      alreadyConfigured: false,
      skipped: false,
      backupPath: null,
      message: `Would ${exists ? "merge kai entry into" : "create"} ${filePath}.`,
    };
  }
  ensureParentDir(filePath);
  const backupPath = exists ? backupFile(filePath) : null;
  atomicWriteFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
  return {
    id: def.id,
    name: def.name,
    path: filePath,
    scope: target.scope,
    wrote: true,
    created: !exists,
    alreadyConfigured: false,
    skipped: false,
    backupPath,
    message: `${!exists ? "Created" : "Updated"} ${filePath} with kai MCP entry.`,
  };
}

export interface AutoSetupOptions extends AgentSetupOptions {
  /** When false (default), agents without a detected binary are skipped. */
  includeMissing?: boolean;
}

/**
 * Automatically wire every agent installed on this system. Detection is the
 * same live PATH probe as `kai agent list`, so only tools actually present
 * are touched; missing tools are reported with install guidance.
 */
export function autoSetupDetectedAgents(
  kaiBin: string,
  opts: AutoSetupOptions = {}
): AgentSetupResult[] {
  const detected = detectInstalledAgentsSync({
    homeDir: opts.homeDir,
    projectDir: opts.projectDir,
  });
  return detected.map((d) => {
    if (!d.binaryFound && !opts.includeMissing) {
      const def = getAgentDefinition(d.id);
      return {
        id: d.id,
        name: d.name,
        path: "",
        scope: "none" as const,
        wrote: false,
        created: false,
        alreadyConfigured: false,
        skipped: true,
        backupPath: null,
        message: `Skipped ${d.name}: not installed. ${def?.installGuidance || ""}`,
      };
    }
    return applyAgentSetup(d.id, kaiBin, opts);
  });
}
