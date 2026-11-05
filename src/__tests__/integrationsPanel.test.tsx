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
  getTeamsStatus: vi.fn(),
  teamsLogin: vi.fn(),
  verifyTeams: vi.fn(),
  teamsLogout: vi.fn(),
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
  describeGroupedAccount,
  groupAccounts,
  initialsOf,
  isSameSelection,
  isServerAccount,
  needsRelogin,
  pickRepoForProject,
  pickSwitchProject,
  preferredAccountId,
  providerLabel,
  summarizeSignIn,
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
  oauth: { available: true, source: "build" },
  ...over,
});

const ANN_UPPER = (org: string) =>
  account({ id: `azure-devops:${org}`, org, user: "ANN@x.com", authMethod: "oauth" });

describe("integrations view model", () => {
  it("makes two-letter avatar initials from a name or an address", () => {
    expect(initialsOf("aj.chand@aitc.ai")).toBe("AC");
    expect(initialsOf("Alex Rivera")).toBe("AR");
    expect(initialsOf("contoso")).toBe("CO");
    expect(initialsOf("x@y.com")).toBe("X");
    expect(initialsOf("")).toBe("?");
    expect(initialsOf("@y.com")).toBe("?");
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
    // One heading word for both: the project in use has its own line, so "Active" is not repeated.
    expect(badgeFor("active")).toEqual({ label: "Connected", tone: "ok" });
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

  it("groups accounts by the signed-in user, keeping order and ignoring case", () => {
    const a = account({ id: "azure-devops:a", org: "a", user: "Ann@x.com", authMethod: "oauth" });
    const b = account({ id: "azure-devops:b", org: "b", user: "bob@y.com", authMethod: "oauth" });
    const c = account({ id: "azure-devops:c", org: "c", user: "ann@x.com", authMethod: "oauth" });
    const d = account({ id: "azure-devops:d", org: "d" });
    const groups = groupAccounts([a, b, c, d]);
    expect(groups.map((g) => [g.label, g.accounts.map((x) => x.org)])).toEqual([
      ["Ann@x.com", ["a", "c"]],
      ["bob@y.com", ["b"]],
      ["Unknown user", ["d"]],
    ]);
    expect(groupAccounts([])).toEqual([]);
    // The user is the group heading, so a grouped row does not repeat it.
    expect(describeGroupedAccount(a)).toBe("a · Browser sign-in");
  });

  it("summarizes what a sign-in changed", () => {
    const ann = (org: string) =>
      account({ id: `azure-devops:${org}`, org, user: "ann@x.com", authMethod: "oauth" });
    const bob = (org: string) =>
      account({ id: `azure-devops:${org}`, org, user: "bob@y.com", authMethod: "oauth" });
    expect(summarizeSignIn([], [ann("a")])).toEqual({
      added: ["a"],
      taken: [],
      alreadySignedIn: false,
    });
    expect(summarizeSignIn([ann("a")], [ann("a")]).alreadySignedIn).toBe(true);
    expect(summarizeSignIn([ann("a")], [ANN_UPPER("a")]).alreadySignedIn).toBe(true);
    const taken = summarizeSignIn([ann("a"), ann("b")], [bob("a"), bob("c")]);
    expect(taken.added).toEqual(["c"]);
    expect(taken.taken).toEqual([{ org: "a", from: "ann@x.com" }]);
    expect(taken.alreadySignedIn).toBe(false);
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
    svc.getTeamsStatus.mockResolvedValue({
      ok: true,
      value: { configured: true, account: null, channelHistory: false },
    });
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

  const notSetUp = () => status({ oauth: { available: false, source: null } });

  it("has no sign-in app form: Connect just starts the browser sign-in", async () => {
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: status() });
    svc.loginWithBrowser.mockResolvedValue({
      ok: false,
      error: { code: "auth", message: "Sign-in was cancelled." },
    });
    await render();
    expect(container.textContent).not.toContain("Sign-in app");
    expect(q("input")).toBeNull();
    await click(button("Connect Azure DevOps"));
    await flush();
    expect(svc.loginWithBrowser).toHaveBeenCalledTimes(1);
    expect(q("form")).toBeNull();
    expect(q("[role=alert]")?.textContent).toContain("Sign-in was cancelled.");
  });

  it("turns Connect off, says why and points to the terminal when this build has no app ID", async () => {
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: notSetUp() });
    await render();
    const connect = button("Connect Azure DevOps");
    expect(connect?.disabled).toBe(true);
    expect(connect?.title).toContain("not set up in this build");
    expect(q("[role=status]")?.textContent).toContain("kai integration azure --az");
    // Nothing to type in: no client ID or directory fields exist anywhere.
    expect(q("form")).toBeNull();
    expect(q("input")).toBeNull();
    await click(connect);
    expect(svc.loginWithBrowser).not.toHaveBeenCalled();
  });

  it("keeps Connect on when an environment variable supplies the app", async () => {
    svc.getIntegrationStatus.mockResolvedValue({
      ok: true,
      value: status({ oauth: { available: true, source: "env" } }),
    });
    await render();
    expect(button("Connect Azure DevOps")?.disabled).toBe(false);
    expect(container.textContent).not.toContain("not set up in this build");
  });

  it("shows Microsoft's refusal of the app as an error, without any form to fix it", async () => {
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: status() });
    svc.loginWithBrowser.mockResolvedValue({
      ok: false,
      error: {
        code: "config",
        message: "Microsoft does not recognize Kai's sign-in app.",
        hint: "Check KAI_AZURE_CLIENT_ID (if set) and the app registration.",
      },
    });
    await render();
    await click(button("Connect Azure DevOps"));
    await flush();
    expect(q("[role=alert]")?.textContent).toContain("does not recognize");
    expect(q("form")).toBeNull();
    expect(q("input")).toBeNull();
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
    expect(container.textContent).toContain("contoso · Azure CLI");
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

  /** A server account whose token is gone: the only way into the Server form now. */
  const stale = (over: Partial<IntegrationStatusView> = {}) =>
    status({ accounts: [serverAccount({ hasCredential: false })], ...over });
  const openServerForm = () =>
    click(q("button[aria-label='Enter a new token for DefaultCollection @ tfs.corp.local']"));

  it("lists accounts grouped by the user who signed in, with a Sign out all for a multi-org user", async () => {
    const ann = (org: string) =>
      account({ id: `azure-devops:${org}`, org, user: "ann@x.com", authMethod: "oauth" });
    const bob = account({
      id: "azure-devops:zed",
      org: "zed",
      user: "bob@y.com",
      authMethod: "oauth",
    });
    svc.getIntegrationStatus
      .mockResolvedValueOnce({
        ok: true,
        value: status({ accounts: [ann("contoso"), ann("fabrikam"), bob] }),
      })
      .mockResolvedValue({ ok: true, value: status({ accounts: [bob] }) });
    svc.logoutIntegration.mockResolvedValue({ ok: true, value: true });
    await render();
    const annGroup = q("section[aria-label='Signed in as ann@x.com']");
    expect(annGroup?.textContent).toContain("2 organizations");
    expect(annGroup?.textContent).toContain("contoso · Browser sign-in");
    expect(annGroup?.textContent).toContain("fabrikam · Browser sign-in");
    expect(annGroup?.textContent).not.toContain("zed");
    const bobGroup = q("section[aria-label='Signed in as bob@y.com']");
    expect(bobGroup?.textContent).toContain("1 organization");
    // One organization has nothing to sign out "all" of.
    expect(bobGroup?.querySelector("button[aria-label^='Sign out all']")).toBeNull();

    await click(q("button[aria-label='Sign out all organizations of ann@x.com']"));
    expect(svc.logoutIntegration).not.toHaveBeenCalled();
    await click(button("Sign out all"));
    expect(svc.logoutIntegration.mock.calls.map((c) => c[0])).toEqual([
      "azure-devops:contoso",
      "azure-devops:fabrikam",
    ]);
    expect(container.textContent).toContain("Signed out ann@x.com.");
  });

  it("says when a sign-in took an organization from another user, and when nothing changed", async () => {
    const was = account({ user: "ann@x.com", authMethod: "oauth" });
    const now = account({ user: "bob@y.com", authMethod: "oauth" });
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: status({ accounts: [was] }) });
    svc.loginWithBrowser.mockResolvedValue({
      ok: true,
      value: { accounts: [now], user: { name: "Bob", email: "bob@y.com" } },
    });
    svc.bindIntegration.mockResolvedValue({
      ok: true,
      value: { account: was.id, project: "Payments", repo: "api" },
    });
    await render();
    await click(button("Add account"));
    await flush();
    expect(container.textContent).toContain("contoso now uses bob@y.com (was ann@x.com).");

    svc.loginWithBrowser.mockResolvedValue({
      ok: true,
      value: { accounts: [was], user: { name: "Ann", email: "ann@x.com" } },
    });
    await click(button("Add account"));
    await flush();
    expect(container.textContent).toContain("Already signed in with this account; refreshed.");
  });

  it("keeps the active account and says how to switch when another sign-in finds several organizations", async () => {
    const { base } = twoAccounts();
    const north = account({ id: "azure-devops:north", org: "north", authMethod: "oauth" });
    const south = account({ id: "azure-devops:south", org: "south", authMethod: "oauth" });
    svc.getIntegrationStatus.mockResolvedValue({
      ok: true,
      value: { ...base, accounts: [...base.accounts, north, south] },
    });
    svc.loginWithBrowser.mockResolvedValue({
      ok: true,
      value: { accounts: [north, south], user: { name: "Zed", email: "zed@z.com" } },
    });
    await render();
    await click(button("Add account"));
    await flush();
    expect(container.textContent).toContain("2 organizations added");
    expect(container.textContent).toContain('"Make active"');
    expect(container.textContent).not.toContain("choose one for this project below");
    expect(svc.bindIntegration).not.toHaveBeenCalled();
    expect(svc.listProjects).not.toHaveBeenCalled();
  });

  it("has no Azure DevOps Server button; the form opens only to re-enter a token", async () => {
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: status() });
    await render();
    expect(button("Azure DevOps Server…")).toBeUndefined();
    expect(container.textContent).not.toContain("Azure DevOps Server…");
    expect(q("form")).toBeNull();
  });

  it("keeps the Server form closed until asked, and closes it again on Cancel", async () => {
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: stale() });
    await render();
    expect(container.textContent).not.toContain("Server URL");
    expect(q("#azure-devops-url")).toBeNull();
    await openServerForm();
    expect(q("form[aria-label='Azure DevOps Server']")).toBeTruthy();
    expect(q("#azure-devops-url")).toBeTruthy();
    expect(q("#azure-devops-server-project")).toBeTruthy();
    // The token is a hidden field, and the form says why a token is needed.
    expect(q<HTMLInputElement>("#azure-devops-token")?.type).toBe("password");
    expect(container.textContent).toContain("signs in with an access token");
    await click(button("Cancel"));
    expect(q("form")).toBeNull();
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
    await openServerForm();
    await type("#azure-devops-url", "https://tfs.corp.local/tfs/DefaultCollection/");
    if (project) await type("#azure-devops-server-project", project);
    await type("#azure-devops-token", "s3cret-token");
    await submit();
    await flush();
  };

  it("explains a bad server address and an empty token without contacting the server", async () => {
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: stale() });
    await render();
    await openServerForm();
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
      .mockResolvedValueOnce({ ok: true, value: stale() })
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
      .mockResolvedValueOnce({ ok: true, value: stale() })
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
      .mockResolvedValueOnce({
        ok: true,
        value: { ...onServer, accounts: [serverAccount({ hasCredential: false })] },
      })
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
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: stale() });
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
    svc.getIntegrationStatus.mockResolvedValueOnce({ ok: true, value: stale() }).mockResolvedValue({
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

describe("IntegrationsPanel: simple card", () => {
  let container: HTMLDivElement;
  let root: Root;
  const flush = () => act(async () => {});
  const text = () => container.textContent ?? "";
  const buttons = () => [...container.querySelectorAll("button")].map((b) => b.textContent?.trim());

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    Object.values(svc).forEach((fn) => fn.mockReset());
    svc.getTeamsStatus.mockResolvedValue({
      ok: true,
      value: { configured: true, account: null, channelHistory: false },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = async (value: IntegrationStatusView) => {
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value });
    await act(async () => {
      root.render(<IntegrationsPanel projectDir="/repo" />);
    });
    await flush();
  };

  const twoOrgs = (): IntegrationStatusView =>
    status({
      accounts: [
        account({
          id: "azure-devops:contoso",
          org: "contoso",
          user: "ann@x.com",
          authMethod: "oauth",
          usedByThisProject: true,
        }),
        account({
          id: "azure-devops:fabrikam",
          org: "fabrikam",
          user: "ann@x.com",
          authMethod: "oauth",
        }),
      ],
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

  it("has no Switch project button and no loose explanations", async () => {
    await render(twoOrgs());
    expect(buttons()).not.toContain("Switch project");
    expect(svc.listProjects).not.toHaveBeenCalled();
    expect(text()).toContain("Connect a service once, then choose it for each project.");
    expect(text()).not.toMatch(/Scoped to|nothing is contacted|from git remote|read through Kai/);
  });

  it("marks exactly one account Active, and offers Make active on the other", async () => {
    await render(twoOrgs());
    const rows = [...container.querySelectorAll("[aria-label='Organizations of ann@x.com'] li")];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Active");
    expect(rows[1].textContent).not.toContain("Active");
    expect(rows[1].textContent).toContain("Make active");
    expect(rows[0].textContent).not.toContain("Make active");
    // The heading says Connected; "Active" appears once, on the account.
    expect(container.querySelector("[data-state]")?.textContent).toBe("Connected");
    expect((text().match(/Active/g) ?? []).length).toBe(1);
  });

  it("offers one way to add another account, named for what it does", async () => {
    await render(twoOrgs());
    expect(buttons()).toContain("Add account");
    expect(buttons()).not.toContain("Sign in with another account");
  });

  it("says Connect Azure DevOps when nobody is signed in yet", async () => {
    await render(status());
    expect(buttons()).toContain("Connect Azure DevOps");
    expect(buttons()).not.toContain("Add account");
  });
});

describe("AiCliPanel tabs", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    Object.values(svc).forEach((fn) => fn.mockReset());
    svc.getTeamsStatus.mockResolvedValue({
      ok: true,
      value: { configured: true, account: null, channelHistory: false },
    });
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
