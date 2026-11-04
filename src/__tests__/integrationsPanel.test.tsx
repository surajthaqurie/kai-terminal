// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { IntegrationAccountView, IntegrationStatusView } from "../core/integrations/rpcTypes";

const svc = vi.hoisted(() => ({
  getIntegrationStatus: vi.fn(),
  listProjects: vi.fn(),
  listRepos: vi.fn(),
  loginWithBrowser: vi.fn(),
  loginWithToken: vi.fn(),
  verifyIntegration: vi.fn(),
  logoutIntegration: vi.fn(),
  bindIntegration: vi.fn(),
  unbindIntegration: vi.fn(),
}));
vi.mock("../services/integrationService", () => svc);

import { DEFAULT_RULES } from "../core/integrations/workflowRules";
import { IntegrationsPanel } from "../components/IntegrationsPanel";
import { AiCliPanel } from "../components/AiCliPanel";
import {
  accountMatchesRemote,
  accountName,
  badgeFor,
  checkServerAddress,
  deriveCardState,
  describeAccount,
  describeDetected,
  explainSignInError,
  isSameSelection,
  isServerAccount,
  needsRelogin,
  pickRepoForProject,
  pickSwitchProject,
  preferredAccountId,
  providerLabel,
  validateServerForm,
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

const serverAccount = (over: Partial<IntegrationAccountView> = {}): IntegrationAccountView =>
  account({
    id: "azure-devops:tfs.corp.local/tfs/defaultcollection",
    org: "DefaultCollection",
    baseUrl: "https://tfs.corp.local/tfs/DefaultCollection",
    authMethod: "pat",
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
  it("explains a missing browser sign-in app with the terminal route, and leaves other errors alone", () => {
    const missing = explainSignInError({
      code: "config",
      message: "Browser sign-in is not set up in this build of Kai.",
      hint: "Set KAI_AZURE_CLIENT_ID.",
    });
    expect(missing.message).toContain("not set up");
    expect(missing.hint).toContain("kai integration azure");
    expect(missing.hint).toContain("KAI_AZURE_CLIENT_ID");
    const other = {
      code: "auth",
      message: "Sign-in was cancelled.",
      hint: "Connect again.",
    } as const;
    expect(explainSignInError(other)).toEqual(other);
  });

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
    expect(describeAccount(account({ authMethod: "oauth" }))).toBe("contoso · Browser sign-in");
    expect(needsRelogin(account({ authMethod: "oauth", hasCredential: false }))).toBe(true);
    expect(providerLabel("azure-devops")).toBe("Azure DevOps");
    expect(providerLabel("jira")).toBe("jira");
    expect(providerLabel(null)).toBe("another integration");
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

  it("names Server accounts by collection and host, Services accounts by organization", () => {
    expect(isServerAccount(account())).toBe(false);
    expect(isServerAccount(account({ baseUrl: "https://contoso.visualstudio.com" }))).toBe(false);
    expect(isServerAccount(serverAccount())).toBe(true);
    expect(accountName(account())).toBe("contoso");
    expect(accountName(serverAccount())).toBe("DefaultCollection @ tfs.corp.local");
    expect(describeAccount(serverAccount({ user: "Suraj" }))).toBe(
      "DefaultCollection @ tfs.corp.local · Access token · Suraj"
    );
  });

  it("matches a remote to a Server account by host and collection, not by name alone", () => {
    const remote = {
      org: "DefaultCollection",
      baseUrl: "https://tfs.corp.local/tfs/DefaultCollection",
    };
    expect(accountMatchesRemote(serverAccount(), remote)).toBe(true);
    expect(
      accountMatchesRemote(
        serverAccount({ baseUrl: "https://tfs.corp.local/tfs/DefaultCollection/" }),
        remote
      )
    ).toBe(true);
    // Another server with the same collection name is a different account.
    expect(
      accountMatchesRemote(
        serverAccount({ baseUrl: "https://other.local/DefaultCollection" }),
        remote
      )
    ).toBe(false);
    // A cloud organization never matches a Server remote of the same name.
    expect(accountMatchesRemote(account({ org: "DefaultCollection" }), remote)).toBe(false);
    // Services accounts still match by organization, as before.
    expect(
      accountMatchesRemote(account(), { org: "CONTOSO", baseUrl: "https://dev.azure.com/contoso" })
    ).toBe(true);
    expect(accountMatchesRemote(account(), null)).toBe(false);
    const s = status({
      accounts: [account(), serverAccount()],
      project: { ...status().project, detected: { ...remote, project: "Web", repo: "site" } },
    });
    expect(preferredAccountId(s)).toBe(serverAccount().id);
  });

  it("checks a server address with the CLI's rules", () => {
    expect(checkServerAddress("  https://tfs.corp.local/tfs/DefaultCollection/  ")).toEqual({
      ok: true,
      baseUrl: "https://tfs.corp.local/tfs/DefaultCollection",
    });
    expect(checkServerAddress("http://tfs:8080/tfs/DefaultCollection?x=1#y")).toEqual({
      ok: true,
      baseUrl: "http://tfs:8080/tfs/DefaultCollection",
    });
    // A pasted clone address is reduced to its collection and offers its project.
    expect(
      checkServerAddress("https://tfs.corp.local/tfs/DefaultCollection/Payments/_git/api")
    ).toEqual({
      ok: true,
      baseUrl: "https://tfs.corp.local/tfs/DefaultCollection",
      project: "Payments",
    });
    const bad = (raw: string) => {
      const r = checkServerAddress(raw);
      expect(r.ok).toBe(false);
      return r.ok ? "" : r.message;
    };
    expect(bad("")).toContain("Enter the server address");
    expect(bad("tfs.corp.local/collection")).toContain("not a valid address");
    expect(bad("ftp://tfs.corp.local/c")).toContain("https://");
    expect(bad("file:///etc/passwd")).toContain("https://");
    expect(bad("https://me:secret@tfs.corp.local/c")).toContain("user name and password");
    expect(bad("https://tfs.corp.local")).toContain("collection");
    expect(bad("https://tfs.corp.local/")).toContain("collection");
    expect(bad("https://tfs.corp.local/_git/api")).toContain("without /_git/");
    expect(bad("https://dev.azure.com/contoso")).toContain("Azure DevOps Services");
    expect(bad("https://contoso.visualstudio.com/DefaultCollection")).toContain(
      "Azure DevOps Services"
    );
  });

  it("validates the whole Server form and reports every problem at once", () => {
    const ok = validateServerForm({
      url: "https://tfs.corp.local/tfs/Col",
      project: " Payments ",
      token: " tok123 ",
    });
    expect(ok).toEqual({
      ok: true,
      value: { baseUrl: "https://tfs.corp.local/tfs/Col", project: "Payments", token: "tok123" },
    });
    // Project is optional; a clone address supplies it.
    expect(validateServerForm({ url: "https://h/c", project: "", token: "t" })).toEqual({
      ok: true,
      value: { baseUrl: "https://h/c", project: null, token: "t" },
    });
    expect(
      validateServerForm({ url: "https://h/c/Web/_git/site", project: "", token: "t" })
    ).toMatchObject({ ok: true, value: { project: "Web" } });

    const all = validateServerForm({ url: "nope", project: "a/b", token: "has space" });
    expect(all.ok).toBe(false);
    if (!all.ok) expect(Object.keys(all.errors).sort()).toEqual(["project", "token", "url"]);
    const empty = validateServerForm({ url: "https://h/c", project: "", token: "  " });
    expect(!empty.ok && empty.errors).toEqual({ token: "Enter an access token." });
    const long = validateServerForm({ url: "https://h/c", project: "", token: "x".repeat(4097) });
    expect(!long.ok && long.errors.token).toContain("too long");
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

  it("shows a not-connected card with one Connect button and nothing to type", async () => {
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: status() });
    await render();
    expect(container.textContent).toContain("Azure DevOps");
    expect(q("[data-state]")?.getAttribute("data-state")).toBe("not_connected");
    expect(container.textContent).toContain("contoso / Payments / api");
    expect(button("Connect Azure DevOps")).toBeTruthy();
    // No organization, token or sign-in method to choose.
    expect(q("form")).toBeNull();
    expect(q("input")).toBeNull();
    expect(container.textContent).not.toContain("Access token");
    expect(container.textContent).not.toContain("Azure CLI");
    expect(container.textContent).not.toContain("az login");
    expect(button("Use for this project")).toBeUndefined();
  });

  it("shows no-remote text when the folder has no Azure DevOps remote", async () => {
    svc.getIntegrationStatus.mockResolvedValue({
      ok: true,
      value: status({ project: { ...status().project, detected: null } }),
    });
    await render();
    expect(container.textContent).toContain("No Azure DevOps remote found in this folder");
  });

  it("connects through the browser, shows progress, and activates the folder's own organization", async () => {
    svc.getIntegrationStatus
      .mockResolvedValueOnce({ ok: true, value: status() })
      .mockResolvedValue({
        ok: true,
        value: status({ accounts: [account({ authMethod: "oauth" })] }),
      });
    let release!: () => void;
    svc.loginWithBrowser.mockReturnValue(
      new Promise((resolve) => {
        release = () =>
          resolve({
            ok: true,
            value: {
              accounts: [
                account({ id: "azure-devops:fabrikam", org: "fabrikam", authMethod: "oauth" }),
                account({ authMethod: "oauth" }),
              ],
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
    await click(button("Connect Azure DevOps"));

    expect(svc.loginWithBrowser).toHaveBeenCalledTimes(1);
    expect(button("Waiting for browser…")?.disabled).toBe(true);
    expect(container.textContent).toContain("Finish signing in in your browser");

    await act(async () => release());
    await flush();
    expect(container.textContent).toContain("Connected to contoso as s@contoso.com.");
    // The account that owns the git remote is chosen without asking.
    expect(svc.bindIntegration).toHaveBeenCalledWith({
      projectDir: "/repo",
      account: "azure-devops:contoso",
    });
    expect(container.textContent).toContain("Active for this project (Payments / api).");
  });

  it("asks which organization when several are found and none is the folder's", async () => {
    const fabrikam = account({ id: "azure-devops:fabrikam", org: "fabrikam", authMethod: "oauth" });
    const northwind = account({
      id: "azure-devops:northwind",
      org: "northwind",
      authMethod: "oauth",
    });
    const noRemote = { ...status().project, detected: null };
    svc.getIntegrationStatus
      .mockResolvedValueOnce({ ok: true, value: status({ project: noRemote }) })
      .mockResolvedValue({
        ok: true,
        value: status({ accounts: [fabrikam, northwind], project: noRemote }),
      });
    svc.loginWithBrowser.mockResolvedValue({
      ok: true,
      value: { accounts: [fabrikam, northwind], user: { name: "Suraj" } },
    });
    await render();
    await click(button("Connect Azure DevOps"));
    await flush();
    expect(container.textContent).toContain("2 organizations found");
    expect(svc.bindIntegration).not.toHaveBeenCalled();
    expect(svc.listProjects).not.toHaveBeenCalled();
    expect(q("select[aria-label='Account for this project']")).toBeTruthy();
  });

  it("lets the user pick the project after connecting when the folder has no remote", async () => {
    const noRemote = { ...status().project, detected: null };
    svc.getIntegrationStatus
      .mockResolvedValueOnce({ ok: true, value: status({ project: noRemote }) })
      .mockResolvedValue({
        ok: true,
        value: status({ accounts: [account()], project: noRemote }),
      });
    svc.loginWithBrowser.mockResolvedValue({
      ok: true,
      value: { accounts: [account()], user: { name: "Suraj", email: "s@contoso.com" } },
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
    await click(button("Connect Azure DevOps"));
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

  it("says what to do when this build has no browser sign-in app, instead of a dead end", async () => {
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: status() });
    svc.loginWithBrowser.mockResolvedValue({
      ok: false,
      error: {
        code: "config",
        message: "Browser sign-in is not set up in this build of Kai.",
        hint: "Register the Kai app in Microsoft Entra and set KAI_AZURE_CLIENT_ID.",
      },
    });
    await render();
    await click(button("Connect Azure DevOps"));
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("Browser sign-in is not set up in this build of Kai.");
    expect(text).toContain('run "kai integration azure" in a terminal');
    expect(text).toContain("Azure CLI or an access token");
  });

  it("keeps the sign-in and asks before replacing another integration", async () => {
    svc.getIntegrationStatus
      .mockResolvedValueOnce({ ok: true, value: status() })
      .mockResolvedValue({ ok: true, value: status({ accounts: [account()] }) });
    svc.loginWithBrowser.mockResolvedValue({
      ok: true,
      value: { accounts: [account()], user: { name: "Suraj" } },
    });
    svc.bindIntegration.mockResolvedValue({
      ok: false,
      error: { code: "needs_confirmation", message: "Already connected to Jira." },
    });
    await render();
    await click(button("Connect Azure DevOps"));
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
          rules: DEFAULT_RULES,
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

  it("keeps the Server form closed until asked, and closes it again on Cancel", async () => {
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: status() });
    await render();
    expect(container.textContent).not.toContain("Server URL");
    expect(q("#azure-devops-url")).toBeNull();
    await click(button("Azure DevOps Server…"));
    expect(q("form[aria-label='Azure DevOps Server']")).toBeTruthy();
    expect(q("#azure-devops-url")).toBeTruthy();
    expect(q("#azure-devops-server-project")).toBeTruthy();
    // The token is a hidden field, and the form says why a token is needed.
    expect(q<HTMLInputElement>("#azure-devops-token")?.type).toBe("password");
    expect(container.textContent).toContain("signs in with an access token");
    expect(button("Azure DevOps Server…")).toBeUndefined();
    await click(button("Cancel"));
    expect(q("form")).toBeNull();
    expect(button("Azure DevOps Server…")).toBeTruthy();
  });

  /** Types into a controlled input the way a user would. */
  const type = async (sel: string, value: string) => {
    const el = q<HTMLInputElement>(sel);
    expect(el).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(el, value);
      el!.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const submit = async () =>
    act(async () => {
      q("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  const fillServer = async (project?: string) => {
    await click(button("Azure DevOps Server…"));
    await type("#azure-devops-url", "https://tfs.corp.local/tfs/DefaultCollection/");
    if (project) await type("#azure-devops-server-project", project);
    await type("#azure-devops-token", "s3cret-token");
    await submit();
    await flush();
  };

  it("explains a bad server address and an empty token without contacting the server", async () => {
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: status() });
    await render();
    await click(button("Azure DevOps Server…"));
    await type("#azure-devops-url", "https://tfs.corp.local");
    await submit();
    expect(svc.loginWithToken).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Add the collection to the address");
    expect(container.textContent).toContain("Enter an access token.");
    expect(q("#azure-devops-url")?.getAttribute("aria-invalid")).toBe("true");
    expect(q("#azure-devops-token")?.getAttribute("aria-invalid")).toBe("true");
  });

  it("signs in to a Server with a token and activates the project typed in the form", async () => {
    const srv = serverAccount();
    svc.getIntegrationStatus
      .mockResolvedValueOnce({ ok: true, value: status() })
      .mockResolvedValue({ ok: true, value: status({ accounts: [srv] }) });
    svc.loginWithToken.mockResolvedValue({
      ok: true,
      value: { account: srv, user: { name: "Suraj", email: "s@corp.local" } },
    });
    svc.bindIntegration.mockResolvedValue({
      ok: true,
      value: { account: srv.id, project: "Payments", repo: null },
    });
    await render();
    await fillServer("Payments");

    // The normalized address and the token go to the sign-in; the project to the bind.
    expect(svc.loginWithToken).toHaveBeenCalledWith({
      baseUrl: "https://tfs.corp.local/tfs/DefaultCollection",
      token: "s3cret-token",
    });
    expect(svc.loginWithBrowser).not.toHaveBeenCalled();
    expect(svc.bindIntegration).toHaveBeenCalledWith({
      projectDir: "/repo",
      account: srv.id,
      project: "Payments",
    });
    expect(container.textContent).toContain(
      "Connected to DefaultCollection @ tfs.corp.local as s@corp.local. Active for this project (Payments)."
    );
    // The form is gone and no copy of the token stays in the page.
    expect(q("form")).toBeNull();
    expect(container.innerHTML).not.toContain("s3cret-token");
    // The account is listed like any other, with Sign out.
    expect(container.textContent).toContain("DefaultCollection @ tfs.corp.local · Access token");
    expect(q("button[aria-label='Sign out DefaultCollection @ tfs.corp.local']")).toBeTruthy();
  });

  it("opens the project picker after a Server sign-in when no project is typed and the remote is elsewhere", async () => {
    const srv = serverAccount();
    svc.getIntegrationStatus
      .mockResolvedValueOnce({ ok: true, value: status() })
      .mockResolvedValue({ ok: true, value: status({ accounts: [srv] }) });
    svc.loginWithToken.mockResolvedValue({
      ok: true,
      value: { account: srv, user: { name: "S" } },
    });
    svc.listProjects.mockResolvedValue({ ok: true, value: [{ name: "Payments" }] });
    svc.listRepos.mockResolvedValue({ ok: true, value: [] });
    await render();
    await fillServer();
    expect(svc.bindIntegration).not.toHaveBeenCalled();
    expect(svc.listProjects).toHaveBeenCalledWith(srv.id);
    expect(q("[aria-label='Switch project']")?.textContent).toContain(
      "Account: DefaultCollection @ tfs.corp.local"
    );
  });

  it("uses the folder's own Server remote when no project is typed", async () => {
    const srv = serverAccount();
    const onServer = status({
      project: {
        ...status().project,
        detected: {
          org: "DefaultCollection",
          project: "Web",
          repo: "site",
          baseUrl: "https://tfs.corp.local/tfs/DefaultCollection",
        },
      },
    });
    svc.getIntegrationStatus
      .mockResolvedValueOnce({ ok: true, value: onServer })
      .mockResolvedValue({ ok: true, value: { ...onServer, accounts: [srv] } });
    svc.loginWithToken.mockResolvedValue({
      ok: true,
      value: { account: srv, user: { name: "S" } },
    });
    svc.bindIntegration.mockResolvedValue({
      ok: true,
      value: { account: srv.id, project: "Web", repo: "site" },
    });
    await render();
    await fillServer();
    expect(svc.bindIntegration).toHaveBeenCalledWith({ projectDir: "/repo", account: srv.id });
    expect(svc.listProjects).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Active for this project (Web / site).");
  });

  it("shows the server's rejection, keeps the form open and saves nothing", async () => {
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: status() });
    svc.loginWithToken.mockResolvedValue({
      ok: false,
      error: { code: "auth", message: "The server rejected the token.", hint: "Create a new one." },
    });
    await render();
    await fillServer();
    expect(q("[role=alert]")?.textContent).toContain("The server rejected the token.");
    expect(q("[role=alert]")?.textContent).toContain("Create a new one.");
    expect(q("form")).toBeTruthy();
    expect(svc.bindIntegration).not.toHaveBeenCalled();
    expect(button("Connect Server")?.disabled).toBe(false);
  });

  it("re-sends the typed project with Replace when another integration is active", async () => {
    const srv = serverAccount();
    svc.getIntegrationStatus
      .mockResolvedValueOnce({ ok: true, value: status() })
      .mockResolvedValue({
        ok: true,
        value: status({ accounts: [srv], project: { ...status().project, otherProvider: "jira" } }),
      });
    svc.loginWithToken.mockResolvedValue({
      ok: true,
      value: { account: srv, user: { name: "S" } },
    });
    svc.bindIntegration
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "needs_confirmation", message: "Replace jira?" },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { account: srv.id, project: "Payments", repo: null },
      });
    await render();
    await fillServer("Payments");
    expect(container.textContent).toContain("Replace jira in this project?");
    await click(button("Replace"));
    expect(svc.bindIntegration).toHaveBeenLastCalledWith({
      projectDir: "/repo",
      account: srv.id,
      project: "Payments",
      replace: true,
    });
  });

  it("offers to enter a new token for a Server account whose token is gone", async () => {
    const srv = serverAccount({ hasCredential: false });
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: status({ accounts: [srv] }) });
    await render();
    expect(container.textContent).toContain("token missing, connect again");
    expect(q("button[aria-label^='Make ']")).toBeNull();
    await click(q("button[aria-label='Enter a new token for DefaultCollection @ tfs.corp.local']"));
    expect(q<HTMLInputElement>("#azure-devops-url")?.value).toBe(
      "https://tfs.corp.local/tfs/DefaultCollection"
    );
  });

  it("signs a Server account out like any other", async () => {
    const srv = serverAccount();
    svc.getIntegrationStatus
      .mockResolvedValueOnce({ ok: true, value: status({ accounts: [srv] }) })
      .mockResolvedValue({ ok: true, value: status() });
    svc.logoutIntegration.mockResolvedValue({ ok: true, value: true });
    await render();
    await click(button("Sign out"));
    await click(container.querySelector('[aria-label="Confirm sign out"] button'));
    expect(svc.logoutIntegration).toHaveBeenCalledWith(srv.id);
  });

  it("shows the CLI's error message and hint in an alert", async () => {
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: status() });
    svc.loginWithBrowser.mockResolvedValue({
      ok: false,
      error: { code: "auth", message: "Sign-in was cancelled.", hint: "Connect again." },
    });
    await render();
    await click(button("Connect Azure DevOps"));
    const alert = q("[role=alert]");
    expect(alert?.textContent).toContain("Sign-in was cancelled.");
    expect(alert?.textContent).toContain("Connect again.");
    // The button is usable again for another try.
    expect(button("Connect Azure DevOps")?.disabled).toBe(false);
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
          rules: DEFAULT_RULES,
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
          rules: DEFAULT_RULES,
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
    expect(button("Connect Azure DevOps")).toBeTruthy();
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
          rules: DEFAULT_RULES,
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
        rules: DEFAULT_RULES,
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
