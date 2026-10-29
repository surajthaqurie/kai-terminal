/**
 * Opt-In Live Verification Test Suite for Azure DevOps Integration.
 *
 * Requirements:
 * - Live verification must be explicitly enabled via AZURE_DEVOPS_LIVE=1.
 * - Live tests remain separate from the default test suite (run with `npm run test:live`).
 * - Never prints credentials, Authorization headers, or PATs.
 * - Performs read-only operations only.
 * - Clearly distinguishes auth, permission, config, and boundary errors.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { createAzureDevOpsProvider } from "../src/core/integrations/providers/azure-devops/index";
import { MemorySecrets } from "../src/core/integrations/secretStore";
import { IntegrationError } from "../src/core/integrations/types";
import type { IntegrationAccount, ProviderContext } from "../src/core/integrations/types";

const isLive = process.env.AZURE_DEVOPS_LIVE === "1" || process.env.AZURE_DEVOPS_LIVE === "true";

describe("Azure DevOps Live Integration (Opt-In)", () => {
  if (!isLive) {
    it.skip("Live verification is opt-in (Status: NOT RUN). Set AZURE_DEVOPS_LIVE=1, AZURE_DEVOPS_ORG, AZURE_DEVOPS_PROJECT to run.", () => {});
    return;
  }

  const org = (process.env.AZURE_DEVOPS_ORG || "").trim();
  const project = (process.env.AZURE_DEVOPS_PROJECT || "").trim();
  const pat = (process.env.AZURE_DEVOPS_PAT || "").trim();
  const boundWorkItemId = process.env.AZURE_DEVOPS_WORK_ITEM_ID
    ? parseInt(process.env.AZURE_DEVOPS_WORK_ITEM_ID, 10)
    : null;
  const foreignWorkItemId = process.env.AZURE_DEVOPS_FOREIGN_WORK_ITEM_ID
    ? parseInt(process.env.AZURE_DEVOPS_FOREIGN_WORK_ITEM_ID, 10)
    : null;

  beforeAll(() => {
    if (!org || !project) {
      throw new Error(
        "Configuration error: AZURE_DEVOPS_ORG and AZURE_DEVOPS_PROJECT environment variables are required for live verification."
      );
    }
  });

  const authMethod = pat ? "pat" : "az";
  const baseUrl = `https://dev.azure.com/${org}`;
  const account: IntegrationAccount = {
    id: `azure-devops:${org.toLowerCase()}`,
    provider: "azure-devops",
    org,
    baseUrl,
    authMethod,
  };

  const secrets = new MemorySecrets();
  const provider = createAzureDevOpsProvider();
  const ctx: ProviderContext = {
    account,
    binding: {
      provider: "azure-devops",
      project,
      repo: null,
    },
    secrets,
  };

  it("authenticates against Azure DevOps without exposing credentials", async () => {
    if (pat) {
      await secrets.set(`azure-devops:${org.toLowerCase()}:pat`, pat);
    }
    const user = await provider.verify(account, secrets);
    expect(user).toBeDefined();
    expect(user.displayName).toBeTruthy();
  });

  it("verifies project access and executes project-scoped work item search", async () => {
    expect(provider.workItems).toBeDefined();
    const result = await provider.workItems!.search(ctx, { limit: 5, offset: 0 });
    expect(result).toBeDefined();
    expect(Array.isArray(result.items)).toBe(true);
  });

  if (boundWorkItemId !== null && !isNaN(boundWorkItemId)) {
    it(`retrieves work item #${boundWorkItemId} belonging to the bound project`, async () => {
      expect(provider.workItems).toBeDefined();
      const item = await provider.workItems!.get(ctx, boundWorkItemId);
      expect(item).toBeDefined();
      expect(item.id).toBe(boundWorkItemId);
      expect(item.title).toBeTruthy();
    });
  } else {
    it.skip("Retrieval of bound work item skipped (AZURE_DEVOPS_WORK_ITEM_ID not configured)", () => {});
  }

  if (foreignWorkItemId !== null && !isNaN(foreignWorkItemId)) {
    it(`rejects work item #${foreignWorkItemId} belonging to a foreign project with not_found`, async () => {
      expect(provider.workItems).toBeDefined();
      await expect(provider.workItems!.get(ctx, foreignWorkItemId)).rejects.toMatchObject({
        code: "not_found",
      });
    });
  } else {
    it.skip("Foreign-project boundary test skipped (AZURE_DEVOPS_FOREIGN_WORK_ITEM_ID not configured)", () => {});
  }
});
