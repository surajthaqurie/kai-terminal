// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { IntegrationStatusView } from "../core/integrations/rpcTypes";
import { DEFAULT_RULES, type WorkflowRules } from "../core/integrations/workflowRules";

const svc = vi.hoisted(() => ({
  getIntegrationStatus: vi.fn(),
  listProjects: vi.fn(),
  listRepos: vi.fn(),
  loginWithBrowser: vi.fn(),
  verifyIntegration: vi.fn(),
  logoutIntegration: vi.fn(),
  bindIntegration: vi.fn(),
  unbindIntegration: vi.fn(),
  setIntegrationRules: vi.fn(),
  listIntegrationBranches: vi.fn(),
}));
vi.mock("../services/integrationService", () => svc);

import { IntegrationsPanel } from "../components/IntegrationsPanel";

const activeStatus = (rules: WorkflowRules = DEFAULT_RULES): IntegrationStatusView => ({
  provider: { id: "azure-devops", label: "Azure DevOps" },
  accounts: [
    {
      id: "azure-devops:contoso",
      provider: "azure-devops",
      org: "contoso",
      baseUrl: "https://dev.azure.com/contoso",
      authMethod: "az",
      hasCredential: true,
      usedByThisProject: true,
    },
  ],
  project: {
    dir: "/repo",
    state: "ready",
    binding: {
      account: "azure-devops:contoso",
      provider: "azure-devops",
      project: "Payments",
      repo: "api",
      boundAt: "2026-10-29T00:00:00Z",
      rules,
    },
    detected: null,
    otherProvider: null,
  },
  azCli: true,
});

describe("WorkflowRulesSection in the Integrations card", () => {
  let container: HTMLDivElement;
  let root: Root;

  const q = <T extends Element>(sel: string) => container.querySelector<T>(sel);
  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as
      HTMLButtonElement | undefined;
  const click = async (el: Element | undefined | null) => {
    expect(el).toBeTruthy();
    await act(async () => {
      (el as HTMLElement).click();
    });
  };
  const select = async (value: string) => {
    const el = q<HTMLSelectElement>("select");
    expect(el).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setter.call(el, value);
      el!.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };
  const optionValues = () => [...container.querySelectorAll("option")].map((o) => o.value);
  const render = async () => {
    await act(async () => {
      root.render(<IntegrationsPanel projectDir="/repo" />);
    });
    await act(async () => {});
  };

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    Object.values(svc).forEach((fn) => fn.mockReset());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const BRANCHES = ["develop", "release/1.2", "trunk"];

  it("keeps the merge branch behind a More link until it is opened", async () => {
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: activeStatus() });
    svc.listIntegrationBranches.mockResolvedValue({ ok: true, value: BRANCHES });
    await render();

    const more = button("More");
    expect(more?.getAttribute("aria-expanded")).toBe("false");
    expect(q('[aria-label="Merge branch"]')).toBeNull();
    expect(svc.listIntegrationBranches).not.toHaveBeenCalled();

    await click(more);
    expect(button("Less")?.getAttribute("aria-expanded")).toBe("true");
    expect(svc.listIntegrationBranches).toHaveBeenCalledWith("/repo");
    expect(q('[aria-label="Merge branch"]')?.textContent).toContain("Merge branch");
    // Only the merge branch: no naming, commit or pull request rules.
    expect(container.textContent).not.toMatch(/commit|pull request title|branch name/i);

    await click(button("Less"));
    expect(q('[aria-label="Merge branch"]')).toBeNull();
  });

  it("offers the repository default first, then the real branches", async () => {
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: activeStatus() });
    svc.listIntegrationBranches.mockResolvedValue({ ok: true, value: BRANCHES });
    await render();
    await click(button("More"));

    expect(optionValues()).toEqual(["", ...BRANCHES]);
    expect(q<HTMLSelectElement>("select")?.value).toBe("");
    expect(button("Save")?.disabled).toBe(true); // nothing changed yet
  });

  it("offers nothing before the project is connected", async () => {
    const connected = activeStatus();
    connected.project = { ...connected.project, state: "none", binding: null };
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: connected });
    await render();
    expect(button("More")).toBeUndefined();
  });

  it("saves the picked branch and re-reads the status", async () => {
    const saved = { ...DEFAULT_RULES, mergeBranch: "develop" };
    svc.getIntegrationStatus
      .mockResolvedValueOnce({ ok: true, value: activeStatus() })
      .mockResolvedValue({ ok: true, value: activeStatus(saved) });
    svc.listIntegrationBranches.mockResolvedValue({ ok: true, value: BRANCHES });
    svc.setIntegrationRules.mockResolvedValue({
      ok: true,
      value: activeStatus(saved).project.binding,
    });
    await render();
    await click(button("More"));

    await select("develop");
    expect(button("Save")?.disabled).toBe(false);
    await click(button("Save"));

    expect(svc.setIntegrationRules).toHaveBeenCalledWith("/repo", { mergeBranch: "develop" });
    expect(svc.getIntegrationStatus).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Saved.");
    expect(button("Save")?.disabled).toBe(true);
  });

  it("goes back to the repository default by picking it", async () => {
    const custom = { ...DEFAULT_RULES, mergeBranch: "develop" };
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: activeStatus(custom) });
    svc.listIntegrationBranches.mockResolvedValue({ ok: true, value: BRANCHES });
    svc.setIntegrationRules.mockResolvedValue({
      ok: true,
      value: activeStatus().project.binding,
    });
    await render();
    await click(button("More"));
    expect(q<HTMLSelectElement>("select")?.value).toBe("develop");

    await select("");
    await click(button("Save"));
    expect(svc.setIntegrationRules).toHaveBeenCalledWith("/repo", { mergeBranch: "" });
  });

  it("keeps a saved branch selectable even when the repository no longer lists it", async () => {
    const custom = { ...DEFAULT_RULES, mergeBranch: "old-branch" };
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: activeStatus(custom) });
    svc.listIntegrationBranches.mockResolvedValue({ ok: true, value: BRANCHES });
    await render();
    await click(button("More"));

    expect(optionValues()).toEqual(["", "old-branch", ...BRANCHES]);
    expect(q<HTMLSelectElement>("select")?.value).toBe("old-branch");
  });

  it("shows why the branches could not be loaded and keeps the current choice", async () => {
    const custom = { ...DEFAULT_RULES, mergeBranch: "develop" };
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: activeStatus(custom) });
    svc.listIntegrationBranches.mockResolvedValue({
      ok: false,
      error: { code: "network", message: "Could not reach Azure DevOps." },
    });
    await render();
    await click(button("More"));

    expect(q("[role=alert]")?.textContent).toContain("Could not reach Azure DevOps.");
    expect(optionValues()).toEqual(["", "develop"]);
    expect(q<HTMLSelectElement>("select")?.value).toBe("develop");
  });

  it("shows the error and keeps the pick when saving fails", async () => {
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: activeStatus() });
    svc.listIntegrationBranches.mockResolvedValue({ ok: true, value: BRANCHES });
    svc.setIntegrationRules.mockResolvedValue({
      ok: false,
      error: { code: "not_found", message: 'The repository has no branch named "develop".' },
    });
    await render();
    await click(button("More"));
    await select("develop");
    await click(button("Save"));

    expect(q("[role=alert]")?.textContent).toContain("has no branch named");
    expect(container.textContent).not.toContain("Saved.");
    expect(q<HTMLSelectElement>("select")?.value).toBe("develop");
  });
});
