import { invoke } from "@tauri-apps/api/core";
import { isTauriAvailable } from "./ptyService";
import { CustomAiCliConfig } from "../types/terminal";

export interface AiCliStatus {
  id: "codex" | "claude" | "gemini" | string;
  name: string;
  available: boolean;
  path: string | null;
}

export type AiCliDiagnosticState =
  | "not_found"
  | "version_detected"
  | "probe_failed"
  | "authentication_required"
  | "authentication_failed"
  | "ready"
  | "launch_failed"
  | "unsupported_version"
  | "unknown";

export interface AiCliDetails extends AiCliStatus {
  version: string | null;
  install_guidance: string;
  diagnostic: string;
  /** Machine-readable status; absent on old backends (treat as unknown). */
  state?: AiCliDiagnosticState;
  /** "unknown" unless a safe provider check proves otherwise. Never inferred. */
  auth_status?: string;
  /** True when the agent's config already contains a kai MCP entry. */
  kai_wired?: boolean;
}

export interface AgentSetupResult {
  id: string;
  path: string;
  wrote: boolean;
  already_configured: boolean;
  backup_path: string | null;
  message: string;
}

/**
 * Optional, local, safe AI CLI detection.
 *
 * - The terminal works identically whether or not any AI CLI is installed.
 * - Presence probing only checks PATH; it never executes third-party
 *   binaries and never requires network access.
 * - Detailed status additionally runs a bounded `<binary> --version` probe
 *   directly (no shell, 8 s timeout) to report versions; failures degrade
 *   to a diagnostic string instead of an error.
 * - Third-party AI CLI executables are never bundled into the installer.
 */
export const KNOWN_AI_CLIS = [
  "codex",
  "claude",
  "gemini",
  "opencode",
  "copilot",
  "aider",
  "cursor",
  "windsurf",
  "cline",
  "agy",
] as const;

function unavailableFallback(): AiCliStatus[] {
  return [
    { id: "codex", name: "Codex CLI", available: false, path: null },
    { id: "claude", name: "Claude Code", available: false, path: null },
    { id: "gemini", name: "Gemini CLI", available: false, path: null },
    { id: "opencode", name: "opencode", available: false, path: null },
    { id: "copilot", name: "Muse CLI", available: false, path: null },
    { id: "aider", name: "Aider", available: false, path: null },
    { id: "cursor", name: "Cursor", available: false, path: null },
    { id: "windsurf", name: "Windsurf", available: false, path: null },
    { id: "cline", name: "Cline", available: false, path: null },
    { id: "agy", name: "Agy", available: false, path: null },
  ];
}

function detailsFallback(): AiCliDetails[] {
  return unavailableFallback().map((s) => ({
    ...s,
    version: null,
    install_guidance: "See official docs for install steps.",
    diagnostic: "AI CLI detection unavailable outside the desktop app.",
  }));
}

export async function getAiCliStatus(): Promise<AiCliStatus[]> {
  if (!isTauriAvailable()) {
    return unavailableFallback();
  }
  try {
    const statuses = await invoke<AiCliStatus[]>("get_ai_cli_status");
    if (!Array.isArray(statuses)) return unavailableFallback();
    return statuses;
  } catch {
    // AI CLI detection is optional: any IPC failure degrades to "none found".
    return unavailableFallback();
  }
}

const CUSTOM_CLI_STORAGE_KEY = "kai_custom_ai_clis";
const LEGACY_CUSTOM_CLI_STORAGE_KEY = "terminal_custom_ai_clis";

export function loadUserCustomClis(): CustomAiCliConfig[] {
  try {
    const raw =
      localStorage.getItem(CUSTOM_CLI_STORAGE_KEY) ||
      localStorage.getItem(LEGACY_CUSTOM_CLI_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((c) => c && typeof c.id === "string" && typeof c.path === "string")
      : [];
  } catch {
    return [];
  }
}

export function saveUserCustomClis(clis: CustomAiCliConfig[]): void {
  try {
    localStorage.setItem(CUSTOM_CLI_STORAGE_KEY, JSON.stringify(clis));
  } catch {
    // ignore
  }
}

/** Frontend mirror of the backend 60 s probe cache: repeat panel opens
 *  serve instantly instead of re-paying up to 10 `--version` probes. */
const DETAILS_CACHE_TTL_MS = 60_000;
let detailsCache: { at: number; data: AiCliDetails[] } | null = null;
let detailsInflight: Promise<AiCliDetails[]> | null = null;

async function fetchAiCliDetailsBase(): Promise<AiCliDetails[]> {
  if (!isTauriAvailable()) {
    return detailsFallback();
  }
  try {
    const details = await invoke<AiCliDetails[]>("get_ai_cli_details");
    return Array.isArray(details) ? details : detailsFallback();
  } catch {
    return detailsFallback();
  }
}

export async function getAiCliDetails(): Promise<AiCliDetails[]> {
  const customClis = loadUserCustomClis();
  // Stale-while-revalidate: serve the last probe result instantly while a
  // background refresh updates the cache for the next open.
  const now = Date.now();
  if (detailsCache && now - detailsCache.at < DETAILS_CACHE_TTL_MS) {
    if (!detailsInflight) {
      detailsInflight = fetchAiCliDetailsBase()
        .then((fresh) => {
          detailsCache = { at: Date.now(), data: fresh };
          return fresh;
        })
        .finally(() => {
          detailsInflight = null;
        });
    }
    const validatedCustom = await validateCustomClis(customClis);
    return [...detailsCache.data, ...validatedCustom];
  }
  if (detailsInflight) {
    const baseDetails = await detailsInflight;
    const validatedCustom = await validateCustomClis(customClis);
    return [...baseDetails, ...validatedCustom];
  }
  detailsInflight = fetchAiCliDetailsBase();
  let baseDetails: AiCliDetails[] = [];
  try {
    baseDetails = await detailsInflight;
    detailsCache = { at: Date.now(), data: baseDetails };
  } finally {
    detailsInflight = null;
  }

  // Append user-configured custom AI CLIs verified via IPC if Tauri is available
  const validatedCustom = await validateCustomClis(customClis);

  return [...baseDetails, ...validatedCustom];
}

async function validateCustomClis(customClis: CustomAiCliConfig[]): Promise<AiCliDetails[]> {
  const validatedCustom: AiCliDetails[] = [];
  for (const c of customClis) {
    if (isTauriAvailable()) {
      try {
        const det = await checkCustomAiCliPath(`custom:${c.id}`, c.path);
        validatedCustom.push({
          ...det,
          name: c.name || det.name,
          install_guidance: c.install_guidance || det.install_guidance,
        });
      } catch {
        validatedCustom.push({
          id: `custom:${c.id}`,
          name: c.name,
          available: false,
          path: c.path,
          version: null,
          install_guidance: c.install_guidance || "User-configured custom executable.",
          diagnostic: `Binary '${c.path}' is missing or not executable.`,
        });
      }
    } else {
      validatedCustom.push({
        id: `custom:${c.id}`,
        name: c.name,
        available: false,
        path: c.path,
        version: null,
        install_guidance: c.install_guidance || "User-configured custom executable.",
        diagnostic: "Executable validation unavailable outside desktop app.",
      });
    }
  }

  return validatedCustom;
}

export async function checkCustomAiCliPath(id: string, customPath: string): Promise<AiCliDetails> {
  const details = await invoke<AiCliDetails>("check_ai_cli_path", {
    id,
    customPath,
  });
  return details;
}

/**
 * Best-effort launcher for the installed kai CLI, resolved by the desktop
 * backend (e.g. `["/usr/local/bin/kai"]`). Used to auto-wire providers
 * without guessing paths. Rejects outside the desktop app.
 */
export async function getKaiCliLaunch(): Promise<string[]> {
  if (!isTauriAvailable()) {
    throw new Error("Auto-wire is only available inside the desktop app.");
  }
  const launcher = await invoke<string[]>("get_kai_cli_launch_cmd");
  if (!Array.isArray(launcher) || launcher.length === 0) {
    throw new Error("kai CLI is not installed on this system.");
  }
  return launcher;
}

/**
 * Automatically install the kai MCP entry into a provider's own config
 * file (with `.kai.bak` backup). `launcher` comes from getKaiCliLaunch().
 */
export async function setupAgentMcp(
  id: string,
  launcher: string[],
  projectArg: string = ".",
  force: boolean = false
): Promise<AgentSetupResult> {
  if (!isTauriAvailable()) {
    throw new Error("Auto-wire is only available inside the desktop app.");
  }
  return await invoke<AgentSetupResult>("setup_agent_mcp_cmd", {
    id,
    launcher,
    projectArg,
    force,
  });
}

export async function registerUserCustomAiCli(config: CustomAiCliConfig): Promise<AiCliDetails> {
  const existing = loadUserCustomClis().filter((c) => c.id !== config.id);
  const updated = [...existing, config];
  saveUserCustomClis(updated);
  if (isTauriAvailable()) {
    return await checkCustomAiCliPath(`custom:${config.id}`, config.path);
  }
  return {
    id: `custom:${config.id}`,
    name: config.name,
    available: false,
    path: config.path,
    version: null,
    install_guidance: config.install_guidance || "User-configured custom executable.",
    diagnostic: "Validation unavailable outside desktop app.",
  };
}

export async function isAnyAiCliAvailable(): Promise<boolean> {
  const statuses = await getAiCliStatus();
  return statuses.some((s) => s.available);
}
