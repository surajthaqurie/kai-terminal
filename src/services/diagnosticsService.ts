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

const DIAGNOSTICS_CACHE_TTL_MS = 60_000;
let diagnosticsCache: { at: number; data: DiagnosticsReport } | null = null;
let diagnosticsInflight: Promise<DiagnosticsReport | null> | null = null;

/** Explicit invalidation for the diagnostics cache (manual refresh, tests). */
export function clearDiagnosticsCache(): void {
  diagnosticsCache = null;
}

async function fetchDiagnostics(): Promise<DiagnosticsReport | null> {
  if (!isTauriAvailable()) return null;
  try {
    return await invoke<DiagnosticsReport>("get_diagnostics");
  } catch (e) {
    console.error("Diagnostics failed:", e);
    return null;
  }
}

export async function getDiagnostics(opts?: {
  force?: boolean;
}): Promise<DiagnosticsReport | null> {
  // Diagnostics fans out to shell detection + AI `--version` probes, so
  // repeat opens within 60 s reuse the last report instead of re-spawning.
  // Explicit `force: true` bypasses the cache for manual refreshes.
  const now = Date.now();
  if (!opts?.force && diagnosticsCache && now - diagnosticsCache.at < DIAGNOSTICS_CACHE_TTL_MS) {
    return diagnosticsCache.data;
  }
  if (diagnosticsInflight) {
    return diagnosticsInflight;
  }
  diagnosticsInflight = fetchDiagnostics();
  try {
    const report = await diagnosticsInflight;
    if (report) {
      diagnosticsCache = { at: Date.now(), data: report };
    }
    return report;
  } finally {
    diagnosticsInflight = null;
  }
}
