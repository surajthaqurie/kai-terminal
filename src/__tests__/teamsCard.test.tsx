// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { TeamsStatusView } from "../core/integrations/rpcTypes";

const svc = vi.hoisted(() => ({
  getTeamsStatus: vi.fn(),
  teamsLogin: vi.fn(),
  verifyTeams: vi.fn(),
  teamsLogout: vi.fn(),
}));
vi.mock("../services/integrationService", () => svc);

import { TeamsIntegrationCard } from "../components/TeamsIntegrationCard";
import {
  deriveTeamsState,
  describeAccess,
  describeTeamsAccount,
  explainTeamsError,
  teamsBadge,
} from "../components/teamsViewModel";

const SIGNED_OUT: TeamsStatusView = { configured: true, account: null, channelHistory: false };
const NOT_SET_UP: TeamsStatusView = { configured: false, account: null, channelHistory: false };
const SIGNED_IN: TeamsStatusView = {
  configured: true,
  account: { id: "oid-1", name: "Alex", email: "alex@contoso.com", signedInAt: "now" },
  channelHistory: false,
};

describe("teams view model", () => {
  it("derives the card state", () => {
    expect(deriveTeamsState(null)).toBe("loading");
    expect(deriveTeamsState(SIGNED_OUT)).toBe("signed_out");
    expect(deriveTeamsState(NOT_SET_UP)).toBe("not_configured");
    expect(deriveTeamsState(SIGNED_IN)).toBe("signed_in");
    // A saved account wins even if this build lost its app id.
    expect(deriveTeamsState({ ...SIGNED_IN, configured: false })).toBe("signed_in");
  });

  it("labels the badge", () => {
    expect(teamsBadge("signed_in")).toEqual({ label: "Signed in", tone: "ok" });
    expect(teamsBadge("not_configured").tone).toBe("warn");
    expect(teamsBadge("signed_out").label).toBe("Not signed in");
  });

  it("describes an account without repeating the name", () => {
    expect(describeTeamsAccount({ name: "Alex", email: "alex@contoso.com" })).toBe(
      "Alex (alex@contoso.com)"
    );
    expect(describeTeamsAccount({ name: "alex@contoso.com", email: "alex@contoso.com" })).toBe(
      "alex@contoso.com"
    );
    expect(describeTeamsAccount({ name: "Alex" })).toBe("Alex");
  });

  it("describes access with the right plurals", () => {
    expect(
      describeAccess({ user: { name: "Alex" }, teams: 1, chats: 2, channelHistory: false })
    ).toBe("Signed in as Alex: 1 team, 2 chats.");
    expect(
      describeAccess({ user: { name: "Alex" }, teams: 3, chats: null, channelHistory: false })
    ).toBe("Signed in as Alex: 3 teams, chats unavailable.");
  });

  it("explains the errors a person can act on", () => {
    expect(
      explainTeamsError({ code: "config", message: "not set up", hint: "set KAI_TEAMS_CLIENT_ID" })
        .hint
    ).toMatch(/no Microsoft app registered.*Maintainers: set KAI_TEAMS_CLIENT_ID/);
    expect(explainTeamsError({ code: "forbidden", message: "no" }).hint).toMatch(/private to you/);
    const other = { code: "network", message: "offline" } as const;
    expect(explainTeamsError(other)).toBe(other);
  });
});

describe("TeamsIntegrationCard", () => {
  let container: HTMLDivElement;
  let root: Root;

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

  async function render(status: TeamsStatusView | { error: string }) {
    svc.getTeamsStatus.mockResolvedValue(
      "error" in status
        ? { ok: false, error: { code: "unavailable", message: status.error } }
        : { ok: true, value: status }
    );
    await act(async () => {
      root.render(<TeamsIntegrationCard />);
    });
  }
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(label));
  async function click(el: Element | undefined) {
    expect(el, "button not found").toBeDefined();
    await act(async () => {
      (el as HTMLElement).click();
    });
  }
  const text = () => container.textContent ?? "";

  it("offers to connect when signed out, and signs in through the browser", async () => {
    await render(SIGNED_OUT);
    expect(text()).toContain("Not signed in");
    svc.teamsLogin.mockResolvedValue({ ok: true, value: SIGNED_IN });
    await click(button("Connect Microsoft Teams"));
    expect(svc.teamsLogin).toHaveBeenCalledWith();
    expect(text()).toContain("Signed in as Alex (alex@contoso.com)");
    expect(text()).toContain("kai teams");
    expect(button("Test connection")).toBeDefined();
    expect(button("Connect Microsoft Teams")).toBeUndefined();
  });

  it("disables sign-in and says why when this build has no Microsoft app", async () => {
    await render(NOT_SET_UP);
    expect(text()).toContain("Not set up");
    expect(text()).toContain("docs/teams-sign-in.md");
    expect((button("Connect Microsoft Teams") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a cancelled sign-in as an error and stays signed out", async () => {
    await render(SIGNED_OUT);
    svc.teamsLogin.mockResolvedValue({
      ok: false,
      error: { code: "auth", message: "Sign-in was cancelled.", hint: "Connect again." },
    });
    await click(button("Connect Microsoft Teams"));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Sign-in was cancelled."
    );
    expect(text()).toContain("Not signed in");
  });

  it("blocks a second click while the browser sign-in is open", async () => {
    await render(SIGNED_OUT);
    let finish: (v: unknown) => void = () => {};
    svc.teamsLogin.mockReturnValue(new Promise((r) => (finish = r)));
    await click(button("Connect Microsoft Teams"));
    expect(text()).toContain("Finish signing in in your browser");
    expect((button("Waiting for browser") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish({ ok: true, value: SIGNED_IN }));
    expect(svc.teamsLogin).toHaveBeenCalledTimes(1);
  });

  it("shows only the account when channel messages are approved: no status line, no warning", async () => {
    await render({ ...SIGNED_IN, channelHistory: true });
    expect(text()).not.toContain("Chats and teams");
    expect(text()).not.toContain("Channel messages");
    expect(button("Try again")).toBeUndefined();
    expect(text()).not.toContain("admin");
  });

  it("signs in once, with channel messages included, and needs no separate step", async () => {
    await render(SIGNED_OUT);
    svc.teamsLogin.mockResolvedValue({ ok: true, value: { ...SIGNED_IN, channelHistory: true } });
    await click(button("Connect Microsoft Teams"));
    expect(svc.teamsLogin).toHaveBeenCalledTimes(1);
    expect(svc.teamsLogin).toHaveBeenCalledWith();
    expect(text()).toContain("Signed in as");
    expect(text()).not.toContain("admin approval");
  });

  it("says channel messages need admin approval, and offers Try again, only when they were not approved", async () => {
    await render(SIGNED_IN);
    expect(text()).toContain("Channel messages need admin approval.");
    expect(text()).not.toContain("Chats and teams");
    svc.teamsLogin.mockResolvedValue({ ok: true, value: SIGNED_IN });
    await click(button("Try again"));
    expect(svc.teamsLogin).toHaveBeenCalledWith();
    expect(text()).toContain("Signed in as");
    expect(text()).toContain("Channel messages need admin approval.");
  });

  it("calls the second sign-in button what it does: Teams keeps one account", async () => {
    await render(SIGNED_IN);
    expect(button("Switch account")).toBeTruthy();
    expect(button("Sign in with another account")).toBeUndefined();
  });

  it("has no refresh button, and re-reads itself when the window regains focus", async () => {
    await render(SIGNED_OUT);
    expect(container.querySelector('[aria-label="Refresh Microsoft Teams status"]')).toBeNull();
    expect(button("Connect Microsoft Teams")).toBeTruthy();
    // Signed in from a terminal in the meantime.
    svc.getTeamsStatus.mockResolvedValue({ ok: true, value: SIGNED_IN });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(text()).toContain("Alex");
    expect(button("Connect Microsoft Teams")).toBeUndefined();
  });

  it("tests the connection", async () => {
    await render(SIGNED_IN);
    svc.verifyTeams.mockResolvedValue({
      ok: true,
      value: { user: { name: "Alex" }, teams: 2, chats: 5, channelHistory: false },
    });
    await click(button("Test connection"));
    expect(text()).toContain("Signed in as Alex: 2 teams, 5 chats.");
  });

  it("asks before signing out, then signs out", async () => {
    await render(SIGNED_IN);
    svc.teamsLogout.mockResolvedValue({ ok: true, value: SIGNED_OUT });
    await click(container.querySelector('[aria-label="Sign out Alex"]') ?? undefined);
    expect(svc.teamsLogout).not.toHaveBeenCalled();
    const confirm = container.querySelector('[aria-label="Confirm sign out"]');
    await click(
      [...(confirm?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Sign out")
    );
    expect(svc.teamsLogout).toHaveBeenCalledTimes(1);
    expect(text()).toContain("Signed out of Microsoft Teams.");
    expect(text()).toContain("Not signed in");
  });

  it("can back out of signing out", async () => {
    await render(SIGNED_IN);
    await click(container.querySelector('[aria-label="Sign out Alex"]') ?? undefined);
    await click(button("Cancel"));
    expect(svc.teamsLogout).not.toHaveBeenCalled();
    expect(text()).toContain("Alex");
    expect(text()).toContain("alex@contoso.com");
  });

  it("shows why status is unavailable instead of crashing", async () => {
    await render({ error: "Integrations are managed by the desktop app." });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "managed by the desktop app"
    );
  });
});
