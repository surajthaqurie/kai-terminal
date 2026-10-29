/**
 * Pure data about the integrations Kai knows. No Node imports, so the desktop
 * UI and the CLI read the same list. Adding a provider means one entry here
 * plus a folder under `providers/`.
 */
export type IntegrationAuthMethod = "az" | "pat";

export interface ProviderInfo {
  id: string;
  label: string;
  /** Short names accepted on the command line (`kai azure`, `kai integration ado`). */
  aliases: readonly string[];
  description: string;
  authMethods: readonly IntegrationAuthMethod[];
}

export const PROVIDER_CATALOG: readonly ProviderInfo[] = [
  {
    id: "azure-devops",
    label: "Azure DevOps",
    aliases: ["azure", "ado"],
    description: "Work items, pull requests and builds, read through Kai's MCP server.",
    authMethods: ["az", "pat"],
  },
];

/** The catalog entry for an id or alias (case-insensitive), or null. */
export function findProvider(name: string): ProviderInfo | null {
  const needle = name.trim().toLowerCase();
  if (!needle) return null;
  return (
    PROVIDER_CATALOG.find((p) => p.id === needle || p.aliases.some((a) => a === needle)) ?? null
  );
}

/** The canonical provider id for an id or alias, or null. */
export function resolveProviderId(name: string): string | null {
  return findProvider(name)?.id ?? null;
}
