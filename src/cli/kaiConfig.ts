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
      return JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch {
      // use defaults
    }
  }
  return { ...DEFAULT_CONFIG };
}
