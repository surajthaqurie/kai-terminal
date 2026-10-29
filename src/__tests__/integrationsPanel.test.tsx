// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { IntegrationAccountView, IntegrationStatusView } from "../core/integrations/rpcTypes";

const svc = vi.hoisted(() => ({
  getIntegrationStatus: vi.fn(),
  listProjects: vi.fn(),
  listRepos: vi.fn(),
  loginIntegration: vi.fn(),
  verifyIntegration: vi.fn(),
  logoutIntegration: vi.fn(),
  bindIntegration: vi.fn(),
  unbindIntegration: vi.fn(),
}));
vi.mock("../services/integrationService", () => svc);

import { IntegrationsPanel } from "../components/IntegrationsPanel";
import { AiCliPanel } from "../components/AiCliPanel";
import {
  badgeFor,
  deriveCardState,
  describeAccount,
  describeDetected,
  initialAuthMethod,
  isSameSelection,
  needsRelogin,
  normalizeOrgInput,
  patPageUrl,
  pickRepoForProject,
  pickSwitchProject,
  preferredAccountId,
  providerLabel,
} from "../components/integrationsViewModel";

const account = (over: Partial<IntegrationAccountView> = {}): IntegrationAccountView => ({
  id: "azure-devops:contoso",
  provider: "azure-devops",
  org: "contoso",
  baseUrl: "https://dev.azure.com/contoso",
  authMethod: "az",
  hasCredential: true,
  usedByThisProject: false,
  ...over,
});

const status = (over: Partial<IntegrationStatusView> = {}): IntegrationStatusView => ({
  provider: { id: "azure-devops", label: "Azure DevOps" },
  accounts: [],
  project: {
    dir: "/repo",
    state: "none",
    binding: null,
    detected: {
      org: "contoso",
      project: "Payments",
      repo: "api",
      baseUrl: "https://dev.azure.com/contoso",
    },
    otherProvider: null,
  },
  azCli: true,
  ...over,
});

describe("integrations view model", () => {
  it("derives one card state from the project binding first, then accounts", () => {
    expect(deriveCardState(null)).toBe("not_connected");
    expect(deriveCardState(status())).toBe("not_connected");
    expect(deriveCardState(status({ accounts: [account()] }))).toBe("connected");
    const bound = (state: IntegrationStatusView["project"]["state"]) =>
      status({ accounts: [account()], project: { ...status().project, state } });
    expect(deriveCardState(bound("ready"))).toBe("active");
    expect(deriveCardState(bound("signed_out"))).toBe("signed_out");
    expect(deriveCardState(bound("account_missing"))).toBe("signed_out");
  });

  it("labels each state", () => {
    expect(badgeFor("not_connected").label).toBe("Not connected");
    expect(badgeFor("connected").label).toBe("Connected");
    expect(badgeFor("active").label).toBe("Active for this project");
    expect(badgeFor("signed_out")).toEqual({ label: "Sign-in needed", tone: "warn" });
  });

  it("prefers the account that matches the git remote's organization", () => {
    const s = status({
      accounts: [account({ id: "azure-devops:fabrikam", org: "fabrikam" }), account()],
    });
    expect(preferredAccountId(s)).toBe("azure-devops:contoso");
    expect(preferredAccountId(status())).toBeNull();
    const noRemote = status({
      accounts: [account({ id: "azure-devops:fabrikam", org: "fabrikam" }), account()],
      project: { ...status().project, detected: null },
    });
    expect(preferredAccountId(noRemote)).toBe("azure-devops:fabrikam");
  });

  it("describes coordinates, accounts and auth", () => {
    expect(describeDetected(null)).toBeNull();
    expect(describeDetected(status().project.detected)).toBe("contoso / Payments / api");
    expect(describeAccount(account({ user: "Suraj" }))).toBe("contoso · Azure CLI · Suraj");
    expect(describeAccount(account({ authMethod: "pat" }))).toBe("contoso · Access token");
    expect(needsRelogin(account({ authMethod: "pat", hasCredential: false }))).toBe(true);
    expect(needsRelogin(account({ authMethod: "az", hasCredential: false }))).toBe(false);
    expect(initialAuthMethod(status({ azCli: false }))).toBe("pat");
    expect(initialAuthMethod(status())).toBe("az");
    expect(providerLabel("azure-devops")).toBe("Azure DevOps");
    expect(providerLabel("jira")).toBe("jira");
    expect(providerLabel(null)).toBe("another integration");
  });

  it("accepts a bare organization or a pasted dev.azure.com URL", () => {
    expect(normalizeOrgInput("  contoso ")).toBe("contoso");
    expect(normalizeOrgInput("https://dev.azure.com/contoso/")).toBe("contoso");
    expect(normalizeOrgInput("https://dev.azure.com/contoso/Payments/_git/api")).toBe("contoso");
  });

  it("points a PAT user at their organization's token page, or the start page", () => {
    expect(patPageUrl("contoso")).toBe("https://dev.azure.com/contoso/_usersSettings/tokens");
    expect(patPageUrl("https://dev.azure.com/contoso/Payments")).toBe(
      "https://dev.azure.com/contoso/_usersSettings/tokens"
    );
    expect(patPageUrl("")).toBe("https://dev.azure.com/");
    expect(patPageUrl("not an org&calc")).toBe("https://dev.azure.com/");
  });

  it("preselects the active project, falling back to the first", () => {
    const projects = [{ name: "Web" }, { name: "Payments" }];
    expect(pickSwitchProject(projects, "payments")).toBe("Payments");
    expect(pickSwitchProject(projects, "Gone")).toBe("Web");
    expect(pickSwitchProject([], "Payments")).toBe("Payments");
  });

  it("keeps the current repo only when the new project has it", () => {
    const repos = [{ name: "API" }, { name: "docs" }];
    expect(pickRepoForProject(repos, "api")).toBe("API");
    expect(pickRepoForProject(repos, "other")).toBeNull();
    expect(pickRepoForProject(repos, null)).toBeNull();
    expect(pickRepoForProject([], "api")).toBeNull();
  });

  it("recognizes a selection that would not change the binding", () => {
    expect(isSameSelection({ project: "Payments", repo: "api" }, "Payments", "api")).toBe(true);
    expect(isSameSelection({ project: "Payments", repo: null }, "Payments", null)).toBe(true);
    expect(isSameSelection({ project: "Payments", repo: "api" }, "Payments", null)).toBe(false);
    expect(isSameSelection({ project: "Payments", repo: "api" }, "Web", "api")).toBe(false);
  });
});

describe("IntegrationsPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  const flush = () => act(async () => {});
  const q = <T extends Element>(sel: string) => container.querySelector<T>(sel);
  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as
      HTMLButtonElement | undefined;
  const type = async (el: HTMLInputElement, value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const click = async (el: Element | undefined | null) => {
    expect(el).toBeTruthy();
    await act(async () => {
      (el as HTMLElement).click();
    });
  };
  const render = async (dir = "/repo") => {
    await act(async () => {
      root.render(<IntegrationsPanel projectDir={dir} />);
    });
    await flush();
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

  it("shows a not-connected card with the connect form and the detected remote", async () => {
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: status() });
    await render();
    expect(container.textContent).toContain("Azure DevOps");
    expect(q("[data-state]")?.getAttribute("data-state")).toBe("not_connected");
    expect(container.textContent).toContain("contoso / Payments / api");
    expect(q<HTMLInputElement>("#azure-devops-org")?.value).toBe("contoso");
    // Azure CLI is the default when it exists, and shows the az login hint.
    expect(container.textContent).toContain("az login");
    expect(q("#azure-devops-pat")).toBeNull();
    expect(button("Use for this project")).toBeUndefined();
  });

  it("defaults to the token method when the Azure CLI is missing", async () => {
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: status({ azCli: false }) });
    await render();
    const pat = q<HTMLInputElement>("#azure-devops-pat");
    expect(pat?.type).toBe("password");
  });

  it("shows no-remote text when the folder has no Azure DevOps remote", async () => {
    svc.getIntegrationStatus.mockResolvedValue({
      ok: true,
      value: status({ project: { ...status().project, detected: null } }),
    });
    await render();
    expect(container.textContent).toContain("No Azure DevOps remote found in this folder");
  });

  it("connects with a token, clears the field on submit and never re-renders it", async () => {
    svc.getIntegrationStatus
      .mockResolvedValueOnce({ ok: true, value: status({ azCli: false }) })
      .mockResolvedValue({
        ok: true,
        value: status({ accounts: [account({ authMethod: "pat" })] }),
      });
    let release!: () => void;
    svc.loginIntegration.mockReturnValue(
      new Promise((resolve) => {
        release = () =>
          resolve({
            ok: true,
            value: {
              account: account({ authMethod: "pat" }),
              user: { name: "Suraj", email: "s@contoso.com" },
            },
          });
      })
    );
    svc.bindIntegration.mockResolvedValue({
      ok: true,
      value: { account: "azure-devops:contoso", project: "Payments", repo: "api" },
    });
    await render();
    await type(q<HTMLInputElement>("#azure-devops-pat")!, "super-secret");
    await act(async () => {
      q<HTMLFormElement>("form")!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );
    });

    expect(svc.loginIntegration).toHaveBeenCalledWith({
      org: "contoso",
      authMethod: "pat",
      pat: "super-secret",
    });
    // Cleared right away, while the request is still in flight.
    expect(q<HTMLInputElement>("#azure-devops-pat")?.value).toBe("");
    expect(button("Connecting…")?.disabled).toBe(true);

    await act(async () => release());
    await flush();
    expect(container.textContent).toContain("Connected to contoso as s@contoso.com.");
    expect(container.innerHTML).not.toContain("super-secret");
    expect(q("form")).toBeNull();
    // The folder's own organization is activated by the same click.
    expect(svc.bindIntegration).toHaveBeenCalledWith({
      projectDir: "/repo",
      account: "azure-devops:contoso",
    });
    expect(container.textContent).toContain("Active for this project (Payments / api).");
  });

  it("lets the user pick the project after connecting when the folder has no remote", async () => {
    const noRemote = { ...status().project, detected: null };
    svc.getIntegrationStatus
      .mockResolvedValueOnce({ ok: true, value: status({ project: noRemote }) })
      .mockResolvedValue({
        ok: true,
        value: status({ accounts: [account()], project: noRemote }),
      });
    svc.loginIntegration.mockResolvedValue({
      ok: true,
      value: { account: account(), user: { name: "Suraj", email: "s@contoso.com" } },
    });
    svc.listProjects.mockResolvedValue({
      ok: true,
      value: [{ name: "Payments" }, { name: "Web" }],
    });
    svc.listRepos.mockResolvedValue({ ok: true, value: [{ name: "api" }] });
    svc.bindIntegration.mockResolvedValue({
      ok: true,
      value: { account: "azure-devops:contoso", project: "Payments", repo: null },
    });
    await render();
    await type(q<HTMLInputElement>("#azure-devops-org")!, "contoso");
    await act(async () => {
      q<HTMLFormElement>("form")!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );
    });
    await flush();
    // Nothing is bound without a project; the picker opens instead.
    expect(svc.bindIntegration).not.toHaveBeenCalled();
    expect(svc.listProjects).toHaveBeenCalledWith("azure-devops:contoso");
    expect(q("#azure-devops-switch-project")).toBeTruthy();
    await click(button("Apply"));
    expect(svc.bindIntegration).toHaveBeenCalledWith({
      projectDir: "/repo",
      account: "azure-devops:contoso",
      project: "Payments",
      repo: null,
    });
    expect(container.textContent).toContain("Active for this project (Payments).");
  });

  it("keeps the sign-in and asks before replacing another integration", async () => {
    svc.getIntegrationStatus
      .mockResolvedValueOnce({ ok: true, value: status() })
      .mockResolvedValue({ ok: true, value: status({ accounts: [account()] }) });
    svc.loginIntegration.mockResolvedValue({
      ok: true,
      value: { account: account(), user: { name: "Suraj" } },
    });
    svc.bindIntegration.mockResolvedValue({
      ok: false,
      error: { code: "needs_confirmation", message: "Already connected to Jira." },
    });
    await render();
    await act(async () => {
      q<HTMLFormElement>("form")!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );
    });
    await flush();
    expect(container.textContent).toContain("Connected to contoso as Suraj.");
    expect(q("[role=group][aria-label='Confirm replace']")).toBeTruthy();
  });

  const twoAccounts = () => {
    const fabrikam = account({ id: "azure-devops:fabrikam", org: "fabrikam" });
    const contoso = account({ usedByThisProject: true });
    const base = status({
      accounts: [contoso, fabrikam],
      project: {
        ...status().project,
        state: "ready",
        binding: {
          account: "azure-devops:contoso",
          provider: "azure-devops",
          project: "Payments",
          repo: "api",
          boundAt: "2026-10-29T00:00:00Z",
        },
      },
    });
    return { fabrikam, contoso, base };
  };

  it("marks one account active and offers Make active only on the others", async () => {
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: twoAccounts().base });
    await render();
    expect(container.textContent).toContain("contoso · Azure CLI · this project");
    expect(q("button[aria-label='Make contoso active for this project']")).toBeNull();
    expect(q("button[aria-label='Make fabrikam active for this project']")).toBeTruthy();
  });

  it("switches the active account by picking a project when the remote is elsewhere", async () => {
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: twoAccounts().base });
    svc.listProjects.mockResolvedValue({ ok: true, value: [{ name: "Payments" }] });
    svc.listRepos.mockResolvedValue({ ok: true, value: [{ name: "api" }] });
    svc.bindIntegration.mockResolvedValue({
      ok: true,
      value: { account: "azure-devops:fabrikam", project: "Payments", repo: null },
    });
    await render();
    await click(q("button[aria-label='Make fabrikam active for this project']"));
    expect(svc.listProjects).toHaveBeenCalledWith("azure-devops:fabrikam");
    // The picker says which account the project is being chosen in.
    expect(q("[aria-label='Switch project']")?.textContent).toContain("Account: fabrikam");
    // Same project name as today's binding, but a different account: still applicable.
    expect(button("Apply")?.disabled).toBe(false);
    await click(button("Apply"));
    expect(svc.bindIntegration).toHaveBeenCalledWith({
      projectDir: "/repo",
      account: "azure-devops:fabrikam",
      project: "Payments",
      repo: null,
    });
  });

  it("switches straight to the account that owns the git remote", async () => {
    const { fabrikam, base } = twoAccounts();
    const onFabrikam = status({
      accounts: [account({ usedByThisProject: false }), { ...fabrikam, usedByThisProject: true }],
      project: {
        ...base.project,
        binding: { ...base.project.binding!, account: "azure-devops:fabrikam" },
      },
    });
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: onFabrikam });
    svc.bindIntegration.mockResolvedValue({
      ok: true,
      value: { account: "azure-devops:contoso", project: "Payments", repo: "api" },
    });
    await render();
    await click(q("button[aria-label='Make contoso active for this project']"));
    expect(svc.bindIntegration).toHaveBeenCalledWith({
      projectDir: "/repo",
      account: "azure-devops:contoso",
    });
    expect(svc.listProjects).not.toHaveBeenCalled();
    expect(container.textContent).toContain("contoso is now active for this project");
  });

  it("warns that connecting an organization twice replaces its sign-in", async () => {
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: twoAccounts().base });
    await render();
    await click(button("Connect another account"));
    await type(q<HTMLInputElement>("#azure-devops-org")!, "Contoso");
    expect(container.textContent).toContain("one sign-in per organization");
    await type(q<HTMLInputElement>("#azure-devops-org")!, "newco");
    expect(container.textContent).not.toContain("one sign-in per organization");
  });

  it("offers no server URL field", async () => {
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: status() });
    await render();
    expect(container.textContent).not.toContain("Server URL");
    expect(q("#azure-devops-url")).toBeNull();
  });

  it("validates the form without calling the CLI", async () => {
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: status({ azCli: false }) });
    await render();
    await type(q<HTMLInputElement>("#azure-devops-org")!, "  ");
    await act(async () => {
      q<HTMLFormElement>("form")!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );
    });
    expect(svc.loginIntegration).not.toHaveBeenCalled();
    expect(q("[role=alert]")?.textContent).toContain("Enter your Azure DevOps organization");
  });

  it("shows the CLI's error message and hint in an alert", async () => {
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: status() });
    svc.loginIntegration.mockResolvedValue({
      ok: false,
      error: { code: "auth", message: "Azure CLI is not signed in.", hint: "az login" },
    });
    await render();
    await act(async () => {
      q<HTMLFormElement>("form")!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );
    });
    const alert = q("[role=alert]");
    expect(alert?.textContent).toContain("Azure CLI is not signed in.");
    expect(alert?.textContent).toContain("az login");
  });

  it("binds the project and then offers only removal, never a second activation", async () => {
    const connected = status({ accounts: [account()] });
    const active = status({
      accounts: [account({ usedByThisProject: true })],
      project: {
        ...status().project,
        state: "ready",
        binding: {
          account: "azure-devops:contoso",
          provider: "azure-devops",
          project: "Payments",
          repo: "api",
          boundAt: "2026-10-29T00:00:00Z",
        },
      },
    });
    svc.getIntegrationStatus
      .mockResolvedValueOnce({ ok: true, value: connected })
      .mockResolvedValue({ ok: true, value: active });
    svc.bindIntegration.mockResolvedValue({ ok: true, value: active.project.binding });
    await render();

    await click(button("Use for this project"));
    expect(svc.bindIntegration).toHaveBeenCalledWith({
      projectDir: "/repo",
      account: "azure-devops:contoso",
    });
    expect(q("[data-state]")?.getAttribute("data-state")).toBe("active");
    expect(button("Use for this project")).toBeUndefined();
    expect(button("Remove from this project")).toBeTruthy();
    expect(container.textContent).toContain("is now active for this project");
  });

  it("asks before replacing another integration, then re-sends with replace", async () => {
    const other = status({
      accounts: [account()],
      project: { ...status().project, otherProvider: "jira" },
    });
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: other });
    svc.bindIntegration
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "needs_confirmation", message: "Replace jira?" },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          account: "a",
          provider: "azure-devops",
          project: "Payments",
          repo: null,
          boundAt: "",
        },
      });
    await render();

    await click(button("Use for this project"));
    expect(container.textContent).toContain("Replace jira in this project?");
    expect(container.textContent).toContain("Only one integration can be active at a time.");

    await click(button("Replace"));
    expect(svc.bindIntegration).toHaveBeenLastCalledWith({
      projectDir: "/repo",
      account: "azure-devops:contoso",
      replace: true,
    });
    expect(container.textContent).not.toContain("Replace jira in this project?");
  });

  it("offers Choose project instead when the folder has no remote", async () => {
    svc.getIntegrationStatus.mockResolvedValue({
      ok: true,
      value: status({
        accounts: [account()],
        project: { ...status().project, detected: null },
      }),
    });
    await render();
    expect(button("Use for this project")).toBeUndefined();
    expect(button("Choose project")?.disabled).toBe(false);
  });

  it("tests the connection and reports who is signed in", async () => {
    svc.getIntegrationStatus.mockResolvedValue({
      ok: true,
      value: status({ accounts: [account()] }),
    });
    svc.verifyIntegration.mockResolvedValue({
      ok: true,
      value: { name: "Suraj", email: "s@contoso.com" },
    });
    await render();
    await click(button("Test connection"));
    expect(svc.verifyIntegration).toHaveBeenCalledWith("azure-devops:contoso");
    expect(q("[role=status]")?.textContent).toContain("Signed in as s@contoso.com.");
  });

  it("removes the binding without signing out", async () => {
    const bound = status({
      accounts: [account({ usedByThisProject: true })],
      project: {
        ...status().project,
        state: "ready",
        binding: {
          account: "azure-devops:contoso",
          provider: "azure-devops",
          project: "Payments",
          repo: "api",
          boundAt: "",
        },
      },
    });
    svc.getIntegrationStatus
      .mockResolvedValueOnce({ ok: true, value: bound })
      .mockResolvedValue({ ok: true, value: status({ accounts: [account()] }) });
    svc.unbindIntegration.mockResolvedValue({ ok: true, value: true });
    await render();
    await click(button("Remove from this project"));
    expect(svc.unbindIntegration).toHaveBeenCalledWith("/repo");
    expect(svc.logoutIntegration).not.toHaveBeenCalled();
    expect(q("[data-state]")?.getAttribute("data-state")).toBe("connected");
  });

  it("confirms before signing out an account", async () => {
    svc.getIntegrationStatus
      .mockResolvedValueOnce({ ok: true, value: status({ accounts: [account()] }) })
      .mockResolvedValue({ ok: true, value: status() });
    svc.logoutIntegration.mockResolvedValue({ ok: true, value: true });
    await render();

    await click(button("Sign out"));
    expect(svc.logoutIntegration).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "Other projects using this account will need to sign in again."
    );

    await click(container.querySelector('[aria-label="Confirm sign out"] button'));
    expect(svc.logoutIntegration).toHaveBeenCalledWith("azure-devops:contoso");
    expect(q("[data-state]")?.getAttribute("data-state")).toBe("not_connected");
    expect(q("form")).not.toBeNull();
  });

  it("flags a bound project whose account needs to sign in again", async () => {
    svc.getIntegrationStatus.mockResolvedValue({
      ok: true,
      value: status({
        accounts: [account({ authMethod: "pat", hasCredential: false })],
        project: { ...status().project, state: "signed_out" },
      }),
    });
    await render();
    expect(q("[data-state]")?.getAttribute("data-state")).toBe("signed_out");
    expect(container.textContent).toContain("token missing, connect again");
  });

  it("surfaces an unavailable backend as an alert with no actions", async () => {
    svc.getIntegrationStatus.mockResolvedValue({
      ok: false,
      error: { code: "unavailable", message: "Integrations are managed by the desktop app." },
    });
    await render();
    expect(q("[role=alert]")?.textContent).toContain("managed by the desktop app");
    expect(button("Connect")).toBeUndefined();
  });
});

describe("IntegrationsPanel: switch project", () => {
  let container: HTMLDivElement;
  let root: Root;

  const flush = () => act(async () => {});
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
  const choose = async (el: HTMLSelectElement, value: string) => {
    await act(async () => {
      el.value = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };
  const options = (el: HTMLSelectElement | null) =>
    [...(el?.options ?? [])].map((o) => o.textContent);

  const active = (over: Partial<IntegrationStatusView["project"]> = {}) =>
    status({
      accounts: [account({ usedByThisProject: true })],
      project: {
        ...status().project,
        state: "ready",
        binding: {
          account: "azure-devops:contoso",
          provider: "azure-devops",
          project: "Payments",
          repo: "api",
          boundAt: "2026-10-29T00:00:00Z",
        },
        ...over,
      },
    });
  const PROJECTS = [{ name: "Web" }, { name: "Payments" }, { name: "Data" }];
  const REPOS: Record<string, { name: string }[]> = {
    Payments: [{ name: "api" }, { name: "ledger" }],
    Web: [{ name: "site" }],
    Data: [{ name: "API" }],
  };

  const render = async () => {
    await act(async () => {
      root.render(<IntegrationsPanel projectDir="/repo" />);
    });
    await flush();
  };

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    Object.values(svc).forEach((fn) => fn.mockReset());
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: active() });
    svc.listProjects.mockResolvedValue({ ok: true, value: PROJECTS });
    svc.listRepos.mockImplementation(async (_account: string, project: string) => ({
      ok: true,
      value: REPOS[project] ?? [],
    }));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("offers the control only on an active project and never loads on tab open", async () => {
    await render();
    expect(button("Switch project")).toBeTruthy();
    expect(svc.listProjects).not.toHaveBeenCalled();
    expect(svc.listRepos).not.toHaveBeenCalled();

    svc.getIntegrationStatus.mockResolvedValue({
      ok: true,
      value: status({ accounts: [account()] }),
    });
    await render();
    await click(
      button("Refresh Azure DevOps status") ?? q('[aria-label="Refresh Azure DevOps status"]')
    );
    expect(button("Switch project")).toBeUndefined();
  });

  it("loads projects on demand, preselects the active one and its repo", async () => {
    let release!: () => void;
    svc.listProjects.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ ok: true, value: PROJECTS });
      })
    );
    await render();
    await click(button("Switch project"));
    expect(svc.listProjects).toHaveBeenCalledWith("azure-devops:contoso");
    expect(container.textContent).toContain("Loading projects…");
    expect(button("Cancel")).toBeTruthy();

    await act(async () => release());
    await flush();
    const project = q<HTMLSelectElement>("#azure-devops-switch-project");
    const repo = q<HTMLSelectElement>("#azure-devops-switch-repo");
    expect(options(project)).toEqual(["Web", "Payments", "Data"]);
    expect(project?.value).toBe("Payments");
    expect(svc.listRepos).toHaveBeenCalledWith("azure-devops:contoso", "Payments");
    expect(options(repo)).toEqual(["(none)", "api", "ledger"]);
    expect(repo?.value).toBe("api");
    // Nothing changed yet, so there is nothing to apply.
    expect(button("Apply")?.disabled).toBe(true);
    expect(svc.bindIntegration).not.toHaveBeenCalled();
  });

  it("reloads repos when the project changes: keeps a matching repo, else (none)", async () => {
    await render();
    await click(button("Switch project"));

    await choose(q<HTMLSelectElement>("#azure-devops-switch-project")!, "Web");
    expect(svc.listRepos).toHaveBeenLastCalledWith("azure-devops:contoso", "Web");
    expect(q<HTMLSelectElement>("#azure-devops-switch-repo")?.value).toBe("");

    // "api" exists in Data as "API": the canonical spelling is selected.
    await choose(q<HTMLSelectElement>("#azure-devops-switch-project")!, "Data");
    expect(q<HTMLSelectElement>("#azure-devops-switch-repo")?.value).toBe("API");
  });

  it("applies the chosen project and repo to this project's account, then refreshes", async () => {
    const switched = active({
      binding: {
        account: "azure-devops:contoso",
        provider: "azure-devops",
        project: "Web",
        repo: "site",
        boundAt: "",
      },
    });
    svc.getIntegrationStatus
      .mockResolvedValueOnce({ ok: true, value: active() })
      .mockResolvedValue({ ok: true, value: switched });
    svc.bindIntegration.mockResolvedValue({ ok: true, value: switched.project.binding });
    await render();
    await click(button("Switch project"));
    await choose(q<HTMLSelectElement>("#azure-devops-switch-project")!, "Web");
    await choose(q<HTMLSelectElement>("#azure-devops-switch-repo")!, "site");

    await click(button("Apply"));
    expect(svc.bindIntegration).toHaveBeenCalledWith({
      projectDir: "/repo",
      account: "azure-devops:contoso",
      project: "Web",
      repo: "site",
    });
    expect(q('[role="group"][aria-label="Switch project"]')).toBeNull();
    expect(q("[role=status]")?.textContent).toContain("Switched to Web / site.");
    expect(container.textContent).toContain("Web / site");
    expect(q("[data-state]")?.getAttribute("data-state")).toBe("active");
  });

  it("sends repo null when (none) is chosen", async () => {
    svc.bindIntegration.mockResolvedValue({
      ok: true,
      value: {
        account: "a",
        provider: "azure-devops",
        project: "Payments",
        repo: null,
        boundAt: "",
      },
    });
    await render();
    await click(button("Switch project"));
    await choose(q<HTMLSelectElement>("#azure-devops-switch-repo")!, "");
    await click(button("Apply"));
    expect(svc.bindIntegration).toHaveBeenCalledWith({
      projectDir: "/repo",
      account: "azure-devops:contoso",
      project: "Payments",
      repo: null,
    });
  });

  it("shows a failed project list inline and leaves the binding untouched", async () => {
    svc.listProjects.mockResolvedValue({
      ok: false,
      error: { code: "network", message: "Could not reach dev.azure.com.", hint: "Check your VPN" },
    });
    await render();
    await click(button("Switch project"));
    const alert = q("[role=alert]");
    expect(alert?.textContent).toContain("Could not reach dev.azure.com.");
    expect(alert?.textContent).toContain("Check your VPN");
    expect(q('[role="group"][aria-label="Switch project"]')).toBeNull();
    expect(svc.bindIntegration).not.toHaveBeenCalled();
    expect(q("[data-state]")?.getAttribute("data-state")).toBe("active");
    expect(button("Switch project")?.disabled).toBe(false);
  });

  it("keeps the picker open and shows the error when applying fails", async () => {
    svc.bindIntegration.mockResolvedValue({
      ok: false,
      error: { code: "not_found", message: 'Project "Web" was not found.', hint: "Pick another" },
    });
    await render();
    await click(button("Switch project"));
    await choose(q<HTMLSelectElement>("#azure-devops-switch-project")!, "Web");
    await click(button("Apply"));
    expect(q("[role=alert]")?.textContent).toContain('Project "Web" was not found.');
    expect(q('[role="group"][aria-label="Switch project"]')).not.toBeNull();
  });

  it("surfaces a repo list failure and leaves only (none) to choose", async () => {
    svc.listRepos.mockResolvedValue({
      ok: false,
      error: { code: "forbidden", message: "No access to repositories." },
    });
    await render();
    await click(button("Switch project"));
    expect(q("[role=alert]")?.textContent).toContain("No access to repositories.");
    expect(options(q<HTMLSelectElement>("#azure-devops-switch-repo"))).toEqual(["(none)"]);
  });

  it("disables the controls while a request is in flight", async () => {
    let release!: () => void;
    await render();
    await click(button("Switch project"));
    svc.listRepos.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ ok: true, value: REPOS.Web });
      })
    );
    await choose(q<HTMLSelectElement>("#azure-devops-switch-project")!, "Web");
    expect(q<HTMLSelectElement>("#azure-devops-switch-project")?.disabled).toBe(true);
    expect(container.textContent).toContain("Loading repositories…");
    expect(button("Apply")?.disabled).toBe(true);
    expect(button("Remove from this project")?.disabled).toBe(true);

    await act(async () => release());
    await flush();
    expect(q<HTMLSelectElement>("#azure-devops-switch-project")?.disabled).toBe(false);
  });

  it("cancel closes the picker and drops a project list that arrives late", async () => {
    let release!: () => void;
    svc.listProjects.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ ok: true, value: PROJECTS });
      })
    );
    await render();
    await click(button("Switch project"));
    await click(button("Cancel"));
    expect(q('[role="group"][aria-label="Switch project"]')).toBeNull();
    expect(button("Switch project")?.disabled).toBe(false);

    await act(async () => release());
    await flush();
    expect(q('[role="group"][aria-label="Switch project"]')).toBeNull();
    expect(svc.listRepos).not.toHaveBeenCalled();
    expect(svc.bindIntegration).not.toHaveBeenCalled();
  });

  it("never offers a second active integration while switching", async () => {
    await render();
    await click(button("Switch project"));
    expect(button("Use for this project")).toBeUndefined();
    expect(container.querySelectorAll("[data-state]").length).toBe(1);
  });
});

describe("AiCliPanel tabs", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    Object.values(svc).forEach((fn) => fn.mockReset());
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: status() });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("opens on AI Providers and switches to Integrations", async () => {
    await act(async () => {
      root.render(<AiCliPanel isOpen={true} onClose={() => {}} projectDir="/repo" />);
    });
    const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(["AI Providers", "Integrations"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector("[data-state]")).toBeNull();
    expect(container.textContent).toContain("AI CLI Providers");

    await act(async () => tabs[1].click());
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(tabs[0].getAttribute("aria-selected")).toBe("false");
    expect(container.querySelector("[data-state]")).not.toBeNull();
    const hiddenBody = container.querySelector<HTMLElement>("#ai-cli-tab-providers");
    expect(hiddenBody).not.toBeNull();
    const providersPanel = container.querySelector<HTMLElement>(
      '[aria-labelledby="ai-cli-tab-providers"]'
    );
    expect(providersPanel?.hidden).toBe(true);
    expect(providersPanel?.style.display).toBe("none");
  });
});
