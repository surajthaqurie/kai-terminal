import type { IntegrationProvider } from "./types";
import { createAzureDevOpsProvider } from "./providers/azure-devops";

/**
 * Registered providers. Adding one means a folder under `providers/`, an entry
 * in `providerCatalog.ts`, and a line in `FACTORIES` below. Nothing else in
 * core, the CLI, the MCP server or the UI needs to learn its name.
 */
const FACTORIES: Record<string, () => IntegrationProvider> = {
  "azure-devops": () => createAzureDevOpsProvider(),
};

const instances = new Map<string, IntegrationProvider>();

export function getProvider(id: string): IntegrationProvider | null {
  const existing = instances.get(id);
  if (existing) return existing;
  const factory = FACTORIES[id];
  if (!factory) return null;
  const created = factory();
  instances.set(id, created);
  return created;
}

/** Test seam: swap a provider (for example one wired to a fake server). */
export function setProviderForTests(id: string, provider: IntegrationProvider | null): void {
  if (provider) instances.set(id, provider);
  else instances.delete(id);
}
