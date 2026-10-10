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
export const KNOWN_AI_CLIS = ["codex", "claude", "gemini"] as const;

function unavailableFallback(): AiCliStatus[] {
  return [
    { id: "codex", name: "Codex CLI", available: false, path: null },
    { id: "claude", name: "Claude Code", available: false, path: null },
    { id: "gemini", name: "Gemini CLI", available: false, path: null },
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

export async function getAiCliDetails(): Promise<AiCliDetails[]> {
  const customClis = loadUserCustomClis();
  let baseDetails: AiCliDetails[] = [];
  if (!isTauriAvailable()) {
    baseDetails = detailsFallback();
  } else {
    try {
      const details = await invoke<AiCliDetails[]>("get_ai_cli_details");
      baseDetails = Array.isArray(details) ? details : detailsFallback();
    } catch {
      baseDetails = detailsFallback();
    }
  }

  // Append user-configured custom AI CLIs verified via IPC if Tauri is available
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

  return [...baseDetails, ...validatedCustom];
}

export async function checkCustomAiCliPath(id: string, customPath: string): Promise<AiCliDetails> {
  const details = await invoke<AiCliDetails>("check_ai_cli_path", {
    id,
    customPath,
  });
  return details;
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
