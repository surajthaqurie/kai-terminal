import { invoke } from "@tauri-apps/api/core";
import { isTauriAvailable } from "./ptyService";

export interface DiagnosticsReport {
  app_version: string;
  os: string;
  arch: string;
  shell_count: number;
  session_count: number;
  ai_cli_summary: Array<{
    id: string;
    available: boolean;
    version: string | null;
  }>;
  notes: string[];
}

export async function getDiagnostics(): Promise<DiagnosticsReport | null> {
  if (!isTauriAvailable()) return null;
  try {
    return await invoke<DiagnosticsReport>("get_diagnostics");
  } catch (e) {
    console.error("Diagnostics failed:", e);
    return null;
  }
}
