import path from "path";
import fs from "fs";
import { getKaiHomeDir } from "../core/registry";

const DEFAULT_CONFIG: Record<string, unknown> = {
  defaultTokenBudget: 4000,
  maxFileSizeBytes: 524288,
  indexingDepth: 20,
  telemetryLocal: true,
};

export function kaiConfigPath(): string {
  return path.join(getKaiHomeDir(), "config.json");
}

/** The user's `~/.kai/config.json`, or the defaults when missing or unreadable. */
export function loadKaiConfig(): Record<string, unknown> {
  const configPath = kaiConfigPath();
  if (fs.existsSync(configPath)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      // A file holding null, a list or a number would break every `config[key]` read.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // use defaults
    }
  }
  return { ...DEFAULT_CONFIG };
}
