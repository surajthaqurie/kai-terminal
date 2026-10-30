import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
let tauri = true;

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("../services/ptyService", () => ({ isTauriAvailable: () => tauri }));

import {
  bindIntegration,
  getIntegrationStatus,
  integrationRpc,
  listProjects,
  listRepos,
  loginWithBrowser,
  logoutIntegration,
  unbindIntegration,
  verifyIntegration,
} from "../services/integrationService";

const reply = (body: unknown) => invoke.mockResolvedValue(JSON.stringify(body));

describe("integrationRpc", () => {
  beforeEach(() => {
    invoke.mockReset();
    tauri = true;
  });

  it("sends one JSON request through the desktop command", async () => {
    reply({ ok: true, done: true });
    await integrationRpc({ op: "logout", account: "azure-devops:contoso" });
    expect(invoke).toHaveBeenCalledTimes(1);
    const [name, args] = invoke.mock.calls[0];
    expect(name).toBe("run_integration_rpc_cmd");
    expect(JSON.parse((args as { requestJson: string }).requestJson)).toEqual({
      op: "logout",
      account: "azure-devops:contoso",
    });
  });

  it("resolves unavailable outside the desktop app and never calls invoke", async () => {
    tauri = false;
    const res = await integrationRpc({ op: "status", projectDir: "/p" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("unavailable");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("turns an IPC failure into an unavailable error without the request body", async () => {
    invoke.mockRejectedValue("The integration request timed out.");
    const res = await integrationRpc({
      op: "login",
      org: "contoso",
      authMethod: "pat",
      pat: "tok",
    });
    expect(res).toEqual({
      ok: false,
      error: { code: "unavailable", message: "The integration request timed out." },
    });
    expect(JSON.stringify(res)).not.toContain("tok");
  });

  it("falls back to a generic message for non-string IPC errors", async () => {
    invoke.mockRejectedValue(new Error("boom"));
    const res = await integrationRpc({ op: "status", projectDir: "/p" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toBe("Could not reach the kai CLI.");
  });

  it("rejects replies that are not JSON or lack an ok flag", async () => {
    invoke.mockResolvedValue("not json");
    expect((await integrationRpc({ op: "status", projectDir: "/p" })).ok).toBe(false);
    reply({ status: {} });
    expect((await integrationRpc({ op: "status", projectDir: "/p" })).ok).toBe(false);
    reply(["ok"]);
    expect((await integrationRpc({ op: "status", projectDir: "/p" })).ok).toBe(false);
  });

  it("keeps an in-band CLI error intact, hint included", async () => {
    const error = { code: "auth", message: "Token rejected", hint: "kai integration azure" };
    reply({ ok: false, error });
    await expect(integrationRpc({ op: "verify", account: "a" })).resolves.toEqual({
      ok: false,
      error,
    });
  });

  it("replaces an ok:false reply with no error details", async () => {
    reply({ ok: false });
    const res = await integrationRpc({ op: "verify", account: "a" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("unavailable");
  });
});

describe("integration helpers", () => {
  beforeEach(() => {
    invoke.mockReset();
    tauri = true;
  });

  const sent = () => JSON.parse((invoke.mock.calls[0][1] as { requestJson: string }).requestJson);

  it("getIntegrationStatus unwraps the status view", async () => {
    const status = { provider: { id: "azure-devops", label: "Azure DevOps" }, accounts: [] };
    reply({ ok: true, status });
    const res = await getIntegrationStatus("/repo");
    expect(sent()).toEqual({ op: "status", projectDir: "/repo" });
    expect(res).toEqual({ ok: true, value: status });
  });

  it("getIntegrationStatus rejects a reply with the wrong shape", async () => {
    reply({ ok: true, done: true });
    const res = await getIntegrationStatus("/repo");
    expect(res.ok).toBe(false);
  });

  it("loginWithBrowser asks for a browser sign-in and returns every account and the user", async () => {
    const accounts = [{ id: "azure-devops:contoso" }, { id: "azure-devops:fabrikam" }];
    const user = { name: "Suraj" };
    reply({ ok: true, accounts, user });
    const res = await loginWithBrowser();
    expect(sent()).toEqual({ op: "login_browser" });
    expect(res).toEqual({ ok: true, value: { accounts, user } });
  });

  it("loginWithBrowser rejects a reply without accounts and keeps an in-band error", async () => {
    reply({ ok: true, account: { id: "x" }, user: { name: "S" } });
    expect((await loginWithBrowser()).ok).toBe(false);
    invoke.mockReset();
    const error = { code: "auth", message: "Sign-in was cancelled.", hint: "Connect again." };
    reply({ ok: false, error });
    await expect(loginWithBrowser()).resolves.toEqual({ ok: false, error });
  });

  it("verifyIntegration returns the signed-in user", async () => {
    reply({ ok: true, user: { name: "Suraj", email: "s@x.io" } });
    const res = await verifyIntegration("azure-devops:contoso");
    expect(sent()).toEqual({ op: "verify", account: "azure-devops:contoso" });
    expect(res).toEqual({ ok: true, value: { name: "Suraj", email: "s@x.io" } });
  });

  it("listProjects sends the account and returns the project list", async () => {
    reply({ ok: true, projects: [{ name: "Payments" }, { name: "Web", description: "Site" }] });
    const res = await listProjects("azure-devops:contoso");
    expect(sent()).toEqual({ op: "projects", account: "azure-devops:contoso" });
    expect(res).toEqual({
      ok: true,
      value: [{ name: "Payments" }, { name: "Web", description: "Site" }],
    });
  });

  it("listRepos sends account and project and returns the repositories", async () => {
    reply({ ok: true, repos: [{ name: "api", defaultBranch: "main" }] });
    const res = await listRepos("azure-devops:contoso", "Payments");
    expect(sent()).toEqual({ op: "repos", account: "azure-devops:contoso", project: "Payments" });
    expect(res).toEqual({ ok: true, value: [{ name: "api", defaultBranch: "main" }] });
  });

  it("listProjects and listRepos keep an in-band error and reject a wrong shape", async () => {
    const error = { code: "network", message: "Could not reach dev.azure.com", hint: "Check VPN" };
    reply({ ok: false, error });
    await expect(listProjects("a")).resolves.toEqual({ ok: false, error });
    invoke.mockReset();
    reply({ ok: true, done: true });
    expect((await listProjects("a")).ok).toBe(false);
    invoke.mockReset();
    reply({ ok: true, projects: [] });
    expect((await listRepos("a", "p")).ok).toBe(false);
  });

  it("logoutIntegration and unbindIntegration need the done flag", async () => {
    reply({ ok: true, done: true });
    await expect(logoutIntegration("a")).resolves.toEqual({ ok: true, value: true });
    invoke.mockReset();
    reply({ ok: true, done: true });
    await expect(unbindIntegration("/repo")).resolves.toEqual({ ok: true, value: true });
    expect(sent()).toEqual({ op: "unbind", projectDir: "/repo", logout: false });
    invoke.mockReset();
    reply({ ok: true, user: { name: "x" } });
    expect((await logoutIntegration("a")).ok).toBe(false);
  });

  it("bindIntegration passes the replace flag and surfaces needs_confirmation", async () => {
    reply({
      ok: false,
      error: { code: "needs_confirmation", message: "Replace jira in this project?" },
    });
    const first = await bindIntegration({ projectDir: "/repo" });
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error.code).toBe("needs_confirmation");

    invoke.mockReset();
    const binding = { account: "azure-devops:contoso", provider: "azure-devops" };
    reply({ ok: true, binding });
    const second = await bindIntegration({ projectDir: "/repo", replace: true });
    expect(sent()).toEqual({ op: "bind", projectDir: "/repo", replace: true });
    expect(second).toEqual({ ok: true, value: binding });
  });
});
