import { execFileSync } from "child_process";
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

/**
 * MCP server registration name written into every agent's config file.
 * Renamed from the legacy "kai" so the server reads as "kai-terminal" in
 * each agent's MCP tool list. Old configs keep working: setup migrates a
 * legacy entry to the new name, detection accepts both, remove cleans both.
 */
export const MCP_SERVER_NAME = "kai-terminal";
export const LEGACY_MCP_SERVER_NAME = "kai";

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
    targets: [
      { scope: "global", relPath: ".claude.json", keyStyle: "mcpServers" },
      { scope: "project", relPath: ".mcp.json", keyStyle: "mcpServers" },
    ],
    buildSetup: (kaiBin: string) => {
      const quotedBin = JSON.stringify(kaiBin);
      return `
Verified Claude Code MCP Configuration:
Add the following to your Claude Code settings (e.g., ~/.claude.json or project config):

{
  "mcpServers": {
    "kai-terminal": {
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
    "kai-terminal": {
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
      "name": "kai-terminal",
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
    configFile: "~/.gemini/settings.json",
    configPaths: [".gemini", ".config/gemini-cli"],
    installGuidance:
      "Install via npm: npm install -g @google/gemini-cli — docs: https://github.com/google-gemini/gemini-cli",
    targets: [{ scope: "global", relPath: ".gemini/settings.json", keyStyle: "mcpServers" }],
    buildSetup: (kaiBin: string) => {
      const quotedBin = JSON.stringify(kaiBin);
      return `
Verified Gemini CLI MCP Configuration:
Add to ~/.gemini/settings.json:

{
  "mcpServers": {
    "kai-terminal": {
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
    name: "GitHub Copilot",
    kind: "ide",
    binaries: ["copilot", "gh-copilot"],
    aliases: ["vscode"],
    configFile: ".vscode/mcp.json",
    configPaths: [".config/github-copilot", ".copilot"],
    installGuidance: "Install GitHub Copilot in VS Code — docs: https://docs.github.com/en/copilot",
    targets: [{ scope: "project", relPath: ".vscode/mcp.json", keyStyle: "vscode-servers" }],
    buildSetup: (kaiBin: string) => {
      const quotedBin = JSON.stringify(kaiBin);
      return `
Verified VS Code / Copilot MCP Configuration:
Add to .vscode/mcp.json:

{
  "servers": {
    "kai-terminal": {
      "type": "stdio",
      "command": "node",
      "args": [${quotedBin}, "mcp", "."]
    }
  }
}

Verification:
Open VS Code MCP settings and confirm the "kai-terminal" server is running.
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
    "kai-terminal": {
      "command": "node",
      "args": [${quotedBin}, "mcp", "."]
    }
  }
}

Verification:
Restart Windsurf and confirm the "kai-terminal" MCP server is connected.
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
    "kai-terminal": {
      "command": "node",
      "args": [${quotedBin}, "mcp", "."]
    }
  }
}

Verification:
Open the Cline MCP settings panel and confirm the "kai-terminal" server is listed.
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
    "kai-terminal": {
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
Writes standard Claude Desktop/MCP format to ~/.config/aider/mcp.json:

{
  "mcpServers": {
    "kai-terminal": {
      "command": "node",
      "args": [${quotedBin}, "mcp", "."]
    }
  }
}

Note:
Stock Aider connects via CLI flags (e.g. aider --mcp-server "node ${quotedBin} mcp .")
or community MCP wrappers (e.g. mcpm-aider) rather than auto-reading mcp.json files.

Verification:
Run: aider
Confirm the "kai-terminal" MCP tools are listed at session start.
`;
    },
  },
  {
    id: "agy",
    name: "Antigravity (agy)",
    kind: "cli",
    binaries: ["agy"],
    aliases: ["antigravity"],
    configFile: "~/.gemini/antigravity-cli/settings.json",
    configPaths: [".gemini/antigravity-cli", ".gemini/antigravity-cli/settings.json"],
    installGuidance:
      "Install Antigravity CLI — docs: https://antigravity.dev or via your vendor's install steps.",
    targets: [
      {
        scope: "global",
        relPath: ".gemini/antigravity-cli/settings.json",
        keyStyle: "mcpServers",
      },
    ],
    buildSetup: (kaiBin: string) => {
      const quotedBin = JSON.stringify(kaiBin);
      return `
Verified Antigravity (agy) MCP Configuration:
Add to ~/.gemini/antigravity-cli/settings.json:

{
  "mcpServers": {
    "kai-terminal": {
      "command": "node",
      "args": [${quotedBin}, "mcp", "."]
    }
  }
}

Verification:
Run: agy
In chat: "Use kai_project_info to inspect the codebase."
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
// Dynamic agent setup (for agents not in AGENT_REGISTRY)
// ---------------------------------------------------------------------------

/**
 * Probe PATH for a binary with the given name.
 * Returns the full resolved path or null when not found.
 * Uses the same logic as findBinaryOnPath (defined below) but is exported
 * for use in the CLI's dynamic fallback path.
 */
export function findDynamicAgentBinary(agentId: string): string | null {
  // Guard against injection — only allow safe binary names.
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(agentId)) return null;
  const envPath = process.env.PATH || process.env.Path || "";
  const isWindows = process.platform === "win32";
  const exts = isWindows
    ? [
        ...(process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .filter(Boolean)
          .map((e) => (e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`)),
        "",
      ]
    : [""];
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const name =
        isWindows && ext && agentId.toLowerCase().endsWith(ext) ? agentId : agentId + ext;
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

export interface DynamicAgentSetupResult {
  wrote: boolean;
  skipped: boolean;
  created: boolean;
  alreadyConfigured: boolean;
  message: string;
  backupPath: string | null;
  snippet: string;
}

/**
 * Build and optionally write a kai MCP entry for an agent that is NOT in
 * the registry. The config is stored at the XDG-style path:
 *   Linux/macOS : ~/.config/<agent>/mcp.json
 *   Windows     : %APPDATA%\<agent>\mcp.json
 *
 * The entry follows the standard mcpServers format used by most agents.
 */
export function buildDynamicAgentSetup(
  agentId: string,
  _agentBinPath: string,
  kaiBin: string,
  opts: AgentSetupOptions = {}
): DynamicAgentSetupResult {
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(agentId)) {
    return {
      wrote: false,
      skipped: true,
      created: false,
      alreadyConfigured: false,
      message: `Invalid agent id "${agentId}". Must contain only alphanumeric characters, underscores, dots, or hyphens (max 64 chars).`,
      backupPath: null,
      snippet: "",
    };
  }
  if (!kaiBin || kaiBin.length > 4096 || /[\0\r\n]/.test(kaiBin)) {
    return {
      wrote: false,
      skipped: true,
      created: false,
      alreadyConfigured: false,
      message: "Refusing to write: kai binary path is invalid.",
      backupPath: null,
      snippet: "",
    };
  }
  const home = opts.homeDir || os.homedir();
  const force = opts.force === true;
  const dryRun = opts.dryRun === true;

  // Resolve config file path (XDG on Linux/macOS, APPDATA on Windows)
  let configDir: string;
  if (process.platform === "win32") {
    configDir = path.join(
      opts.homeDir
        ? path.join(opts.homeDir, "AppData", "Roaming")
        : process.env.APPDATA || path.join(home, "AppData", "Roaming"),
      agentId
    );
  } else {
    const xdgConfig = opts.homeDir
      ? path.join(opts.homeDir, ".config")
      : process.env.XDG_CONFIG_HOME || path.join(home, ".config");
    configDir = path.join(xdgConfig, agentId);
  }
  const filePath = path.join(configDir, "mcp.json");

  const quotedBin = JSON.stringify(kaiBin);
  const snippet = `
Verified ${agentId} MCP Configuration (auto-generated):
Add to ${filePath}:

{
  "mcpServers": {
    "kai-terminal": {
      "command": "node",
      "args": [${quotedBin}, "mcp", "."]
    }
  }
}

Verification:
Run: ${agentId}
In chat: "Use kai_project_info to inspect the codebase."
`;

  const { exists, data, parseError } = readJsonConfig(filePath);
  if (parseError) {
    return {
      wrote: false,
      skipped: true,
      created: false,
      alreadyConfigured: false,
      message: `${filePath}: ${parseError}`,
      backupPath: null,
      snippet,
    };
  }
  const { alreadyConfigured } = mergeKaiMcpEntry(data, "mcpServers", kaiBin, ".", force);
  if (alreadyConfigured) {
    return {
      wrote: false,
      skipped: false,
      created: false,
      alreadyConfigured: true,
      message: `kai-terminal entry already present in ${filePath}.`,
      backupPath: null,
      snippet,
    };
  }
  if (dryRun) {
    return {
      wrote: false,
      skipped: false,
      created: !exists,
      alreadyConfigured: false,
      message: `Would ${exists ? "merge kai-terminal entry into" : "create"} ${filePath}.`,
      backupPath: null,
      snippet,
    };
  }
  try {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const backupPath = exists
      ? (() => {
          try {
            const bp = `${filePath}.kai.bak`;
            fs.copyFileSync(filePath, bp);
            return bp;
          } catch {
            return null;
          }
        })()
      : null;
    const tmpPath = `${filePath}.kai.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, {
      mode: 0o600,
      encoding: "utf-8",
    });
    fs.renameSync(tmpPath, filePath);
    return {
      wrote: true,
      skipped: false,
      created: !exists,
      alreadyConfigured: false,
      message: `${!exists ? "Created" : "Updated"} ${filePath} with kai-terminal MCP entry.`,
      backupPath,
      snippet,
    };
  } catch (err: unknown) {
    return {
      wrote: false,
      skipped: true,
      created: false,
      alreadyConfigured: false,
      message: `Failed to write ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      backupPath: null,
      snippet,
    };
  }
}

// ---------------------------------------------------------------------------
// Dynamic system detection (PATH + config presence, no execution)
// ---------------------------------------------------------------------------

export function findBinaryOnPath(bin: string): string | null {
  if (!/^[a-zA-Z0-9_.-]+$/.test(bin)) return null;
  const envPath = process.env.PATH || process.env.Path || "";
  const isWindows = process.platform === "win32";
  const exts = isWindows
    ? [
        ...(process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .filter(Boolean)
          .map((e) => (e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`)),
        "",
      ]
    : [""];
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const name = isWindows && ext && bin.toLowerCase().endsWith(ext) ? bin : bin + ext;
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
 * Check whether a directory is inside a Git repository.
 * Checks upward for a `.git` directory or file, falling back to `git rev-parse`.
 */
export function isGitRepository(dir: string): boolean {
  if (!dir) return false;
  try {
    let cur = path.resolve(dir);
    while (true) {
      if (fs.existsSync(path.join(cur, ".git"))) {
        return true;
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  } catch {
    // ignore filesystem errors
  }
  try {
    const res = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();
    if (res === "true") return true;
  } catch {
    // not a git repo or git not found
  }
  return false;
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
  const inGit = isGitRepository(projectDir);
  // Auto scope prefers project targets first when inside a git repo,
  // or global targets first when outside a git repo.
  const ordered = [...candidates].sort((a, b) => {
    if (wanted !== "auto" || a.scope === b.scope) return 0;
    if (inGit) {
      return a.scope === "project" ? -1 : 1;
    }
    return a.scope === "global" ? -1 : 1;
  });
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

/** Insert (or refresh with force) the kai-terminal entry inside a parsed
 *  JSON config. A legacy "kai" entry is migrated: it is removed and the
 *  entry is rewritten under the new name. */
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
  if (servers[MCP_SERVER_NAME] !== undefined && !force) return { alreadyConfigured: true };
  // Migration: the legacy "kai" key moves out of the way so each agent sees
  // exactly one kai-terminal server (no duplicate registration).
  delete servers[LEGACY_MCP_SERVER_NAME];
  servers[MCP_SERVER_NAME] = entry;
  return { alreadyConfigured: false };
}

function hasKaiJsonEntry(data: Record<string, unknown>): boolean {
  for (const key of ["mcpServers", "mcp", "mcp_servers", "servers"]) {
    const container = data[key];
    if (
      container &&
      typeof container === "object" &&
      !Array.isArray(container) &&
      ((container as Record<string, unknown>)[MCP_SERVER_NAME] !== undefined ||
        (container as Record<string, unknown>)[LEGACY_MCP_SERVER_NAME] !== undefined)
    ) {
      return true;
    }
  }
  return false;
}

const CODEX_TOML_SECTION = `mcp_servers.${MCP_SERVER_NAME}`;
const LEGACY_TOML_SECTIONS = [`mcp_servers.${LEGACY_MCP_SERVER_NAME}`];

/** Match one full `[section]` TOML block up to the next section or EOF. */
function tomlSectionRegex(section: string): RegExp {
  return new RegExp(`\\n?\\[${section.replace(/\./g, "\\.")}\\][\\s\\S]*?(?=\\n\\[|$)`, "g");
}

/** Remove any previously written kai server table block(s) — the new
 *  `kai-terminal` section and any legacy `[mcp_servers.kai]` block left by
 *  older releases — so setup never appends a duplicate table. */
function stripKaiTomlSections(raw: string): string {
  let out = raw.replace(tomlSectionRegex(CODEX_TOML_SECTION), "");
  for (const section of LEGACY_TOML_SECTIONS) {
    out = out.replace(tomlSectionRegex(section), "");
  }
  return out;
}

function hasCodexTomlEntry(raw: string): boolean {
  if (raw.includes(`[${CODEX_TOML_SECTION}]`) || raw.includes(`${CODEX_TOML_SECTION}.`)) {
    return true;
  }
  return LEGACY_TOML_SECTIONS.some(
    (section) => raw.includes(`[${section}]`) || raw.includes(`${section}.`)
  );
}

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
  dryRun: boolean,
  note: string = ""
): Omit<AgentSetupResult, "id" | "name" | "path" | "scope"> {
  let existing = "";
  let fileExists = false;
  try {
    existing = fs.readFileSync(filePath, "utf-8");
    fileExists = true;
  } catch {
    fileExists = false;
  }
  const hasNew =
    existing.includes(`[${CODEX_TOML_SECTION}]`) || existing.includes(`${CODEX_TOML_SECTION}.`);
  if (hasNew && !force) {
    return {
      wrote: false,
      created: false,
      alreadyConfigured: true,
      skipped: false,
      backupPath: null,
      message: `kai-terminal entry already present in ${filePath}.${note}`,
    };
  }
  if (dryRun) {
    return {
      wrote: false,
      created: !fileExists,
      alreadyConfigured: false,
      skipped: false,
      backupPath: null,
      message: `Would ${fileExists ? "append kai-terminal section to" : "create"} ${filePath}.${note}`,
    };
  }
  try {
    ensureParentDir(filePath);
    let backupPath: string | null = null;
    if (fileExists) backupPath = backupFile(filePath);
    const section = buildCodexTomlSection(kaiBin, projectArg);
    // Forced refresh (or legacy migration) replaces any stale kai section with
    // the new one, so TOML never ends up with a duplicate table.
    const cleaned = stripKaiTomlSections(existing);
    const next =
      !fileExists || !cleaned.endsWith("\n")
        ? `${cleaned}${fileExists ? "\n" : ""}\n${section}`
        : `${cleaned}\n${section}`;
    atomicWriteFile(filePath, fileExists ? next : `${section}`);
    return {
      wrote: true,
      created: !fileExists,
      alreadyConfigured: false,
      skipped: false,
      backupPath,
      message: `Wrote kai-terminal MCP section to ${filePath}.${note}`,
    };
  } catch (err) {
    return {
      wrote: false,
      created: false,
      alreadyConfigured: false,
      skipped: true,
      backupPath: null,
      message: `Failed to write config file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
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
  // Retry on Windows transient locks (AV scanners, lingering handles) so
  // agent setup behaves identically on Linux, macOS, and Windows.
  const attempts = process.platform === "win32" ? 8 : 1;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      fs.renameSync(tmpPath, filePath);
      return;
    } catch (err: unknown) {
      lastError = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      const retryable = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!retryable || attempt === attempts - 1) break;
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      } catch {
        // Atomics.wait unavailable; fall through to immediate retry.
      }
    }
  }
  try {
    fs.rmSync(tmpPath, { force: true });
  } catch {
    // Ignore cleanup failure; surface the original rename error below.
  }
  throw lastError;
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
      return hasCodexTomlEntry(raw);
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
      message: `Unknown agent "${agent}". Run 'kai list -a' for targets.`,
    };
  }
  if (!kaiBin || kaiBin.length > 4096 || /[\0\r\n]/.test(kaiBin)) {
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
  const projectArg = def.projectArg || ".";
  if (projectArg.length > 4096 || /[\0\r\n]/.test(projectArg)) {
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
      message: "Refusing to write: project argument is invalid.",
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
  const dryRun = opts.dryRun === true;
  const force = opts.force === true;

  let binaryFound = false;
  for (const bin of def.binaries) {
    if (findBinaryOnPath(bin)) {
      binaryFound = true;
      break;
    }
  }
  const missingNote =
    !binaryFound && def.kind === "cli"
      ? ` (Note: '${def.name}' binary was not detected on PATH. ${def.installGuidance})`
      : "";

  if (target.keyStyle === "toml-codex") {
    const r = applyCodexTomlSetup(filePath, kaiBin, projectArg, force, dryRun, missingNote);
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
      message: `kai-terminal entry already present in ${filePath}.${missingNote}`,
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
      message: `Would ${exists ? "merge kai-terminal entry into" : "create"} ${filePath}.${missingNote}`,
    };
  }
  try {
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
      message: `${!exists ? "Created" : "Updated"} ${filePath} with kai-terminal MCP entry.${missingNote}`,
    };
  } catch (err) {
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
      message: `Failed to write config file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export interface ApprovalResult {
  path: string;
  /** True when this call changed the file. */
  wrote: boolean;
  message: string;
}

/**
 * Claude Code asks before it starts a server named in a project's `.mcp.json`.
 * Record that the user's own kai-terminal entry is approved, in the git-ignored
 * `.claude/settings.local.json`, so `kai claude` starts without that prompt.
 * Only kai-terminal is named (never "all servers"), other keys are kept, and a
 * server the user listed under `disabledMcpjsonServers` stays disabled.
 */
export function approveKaiForClaudeProject(projectDir: string): ApprovalResult {
  const filePath = path.join(projectDir, ".claude", "settings.local.json");
  const { exists, data, parseError } = readJsonConfig(filePath);
  if (parseError) {
    return { path: filePath, wrote: false, message: `${filePath}: ${parseError}` };
  }
  const names = (key: string): string[] =>
    Array.isArray(data[key])
      ? (data[key] as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
  if (names("disabledMcpjsonServers").includes(MCP_SERVER_NAME)) {
    return { path: filePath, wrote: false, message: `${MCP_SERVER_NAME} is disabled by the user.` };
  }
  const enabled = names("enabledMcpjsonServers");
  if (enabled.includes(MCP_SERVER_NAME)) {
    return { path: filePath, wrote: false, message: `${MCP_SERVER_NAME} is already approved.` };
  }
  data.enabledMcpjsonServers = [...enabled, MCP_SERVER_NAME];
  try {
    ensureParentDir(filePath);
    if (exists) backupFile(filePath);
    atomicWriteFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
    return { path: filePath, wrote: true, message: `Approved ${MCP_SERVER_NAME} in ${filePath}.` };
  } catch (err) {
    return {
      path: filePath,
      wrote: false,
      message: `Failed to write ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
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

export interface AgentRemoveResult {
  id: string;
  name: string;
  path: string;
  removed: boolean;
  message: string;
}

/**
 * Remove Kai MCP wiring from an agent's configuration file.
 */
export function removeAgentSetup(agent: string, opts: AgentSetupOptions = {}): AgentRemoveResult {
  const def = getAgentDefinition(agent);
  if (!def) {
    return {
      id: agent,
      name: agent,
      path: "",
      removed: false,
      message: `Unknown agent "${agent}". Run 'kai list -a' to see available agents.`,
    };
  }
  const resolved = resolveAgentConfigPath(def, opts);
  if ("error" in resolved) {
    return {
      id: def.id,
      name: def.name,
      path: "",
      removed: false,
      message: resolved.error,
    };
  }
  const { path: filePath, target } = resolved;
  if (!fs.existsSync(filePath)) {
    return {
      id: def.id,
      name: def.name,
      path: filePath,
      removed: false,
      message: `Config file ${filePath} does not exist.`,
    };
  }

  const dryRun = opts.dryRun === true;

  if (target.keyStyle === "toml-codex") {
    const raw = fs.readFileSync(filePath, "utf-8");
    if (!hasCodexTomlEntry(raw)) {
      return {
        id: def.id,
        name: def.name,
        path: filePath,
        removed: false,
        message: `No kai-terminal MCP entry found in ${filePath}.`,
      };
    }
    if (dryRun) {
      return {
        id: def.id,
        name: def.name,
        path: filePath,
        removed: true,
        message: `Would remove kai-terminal MCP section from ${filePath}.`,
      };
    }
    try {
      backupFile(filePath);
      const updated = stripKaiTomlSections(raw);
      atomicWriteFile(filePath, updated);
      return {
        id: def.id,
        name: def.name,
        path: filePath,
        removed: true,
        message: `Removed kai-terminal MCP section from ${filePath}.`,
      };
    } catch (err) {
      return {
        id: def.id,
        name: def.name,
        path: filePath,
        removed: false,
        message: `Failed to update config file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const parsed = readJsonConfig(filePath);
  if (parsed.parseError) {
    return {
      id: def.id,
      name: def.name,
      path: filePath,
      removed: false,
      message: parsed.parseError,
    };
  }

  const containerKey =
    target.keyStyle === "mcp-opencode"
      ? "mcp"
      : target.keyStyle === "mcp_servers"
        ? "mcp_servers"
        : target.keyStyle === "vscode-servers"
          ? "servers"
          : "mcpServers";

  const container = parsed.data[containerKey] as Record<string, unknown> | undefined;
  const hasServer =
    container &&
    typeof container === "object" &&
    (container[MCP_SERVER_NAME] !== undefined || container[LEGACY_MCP_SERVER_NAME] !== undefined);
  if (!hasServer) {
    return {
      id: def.id,
      name: def.name,
      path: filePath,
      removed: false,
      message: `No kai-terminal MCP entry found in ${filePath}.`,
    };
  }

  if (dryRun) {
    return {
      id: def.id,
      name: def.name,
      path: filePath,
      removed: true,
      message: `Would remove kai-terminal MCP entry from ${filePath}.`,
    };
  }

  try {
    backupFile(filePath);
    delete container[MCP_SERVER_NAME];
    delete container[LEGACY_MCP_SERVER_NAME];
    atomicWriteFile(filePath, JSON.stringify(parsed.data, null, 2) + "\n");
    return {
      id: def.id,
      name: def.name,
      path: filePath,
      removed: true,
      message: `Removed kai-terminal MCP entry from ${filePath}.`,
    };
  } catch (err) {
    return {
      id: def.id,
      name: def.name,
      path: filePath,
      removed: false,
      message: `Failed to update config file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
