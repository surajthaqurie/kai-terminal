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
  getTeamsStatus: vi.fn(),
  teamsLogin: vi.fn(),
  verifyTeams: vi.fn(),
  teamsLogout: vi.fn(),
}));
vi.mock("../services/integrationService", () => svc);

import { IntegrationsPanel } from "../components/IntegrationsPanel";

const activeStatus = (rules: WorkflowRules = DEFAULT_RULES): IntegrationStatusView => ({
  provider: { id: "azure-devops", label: "Azure DevOps" },
  oauth: { available: true, source: "build" },
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
  const mergeInput = () => q<HTMLInputElement>('input[id$="-merge"]');
  const patternInput = () => q<HTMLTextAreaElement>('textarea[id$="-pattern"]');
  const typeInto = async (el: HTMLInputElement | HTMLTextAreaElement | null, value: string) => {
    expect(el).toBeTruthy();
    await act(async () => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value")!.set!;
      setter.call(el, value);
      el!.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  /** Types a branch into the Merge branch box. */
  const typeBranch = (value: string) => typeInto(mergeInput(), value);
  /** Types into the Branch naming (regex) box. */
  const type = (value: string) => typeInto(patternInput(), value);
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

  it("keeps the merge branch behind a Branch rules toggle until it is opened", async () => {
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: activeStatus() });
    await render();

    const more = button("Branch rules");
    expect(more?.getAttribute("aria-expanded")).toBe("false");
    expect(q('[aria-label="Branch rules"]')).toBeNull();

    await click(more);
    expect(button("Branch rules")?.getAttribute("aria-expanded")).toBe("true");
    const group = q('[aria-label="Branch rules"]')?.textContent ?? "";
    expect(group).toContain("Merge branch");
    expect(group).toContain("Branch naming (regex)");
    // Only these two: no commit message or pull request title rules.
    expect(container.textContent).not.toMatch(/commit|pull request title/i);

    await click(button("Branch rules"));
    expect(q('[aria-label="Branch rules"]')).toBeNull();
  });

  it("is a text box that is empty for the repository default, and loads no branches", async () => {
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: activeStatus() });
    await render();
    await click(button("Branch rules"));

    expect(container.querySelector("select")).toBeNull();
    expect(mergeInput()?.value).toBe("");
    expect(mergeInput()?.placeholder).toContain("Repository default");
    expect(container.textContent).not.toContain("Loading branches");
    expect(button("Save")?.disabled).toBe(true); // nothing changed yet
  });

  it("offers nothing before the project is connected", async () => {
    const connected = activeStatus();
    connected.project = { ...connected.project, state: "none", binding: null };
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: connected });
    await render();
    expect(button("Branch rules")).toBeUndefined();
  });

  it("saves the typed branch and re-reads the status", async () => {
    const saved = { ...DEFAULT_RULES, mergeBranch: "develop" };
    svc.getIntegrationStatus
      .mockResolvedValueOnce({ ok: true, value: activeStatus() })
      .mockResolvedValue({ ok: true, value: activeStatus(saved) });
    svc.setIntegrationRules.mockResolvedValue({
      ok: true,
      value: activeStatus(saved).project.binding,
    });
    await render();
    await click(button("Branch rules"));

    await typeBranch("develop");
    expect(button("Save")?.disabled).toBe(false);
    await click(button("Save"));

    expect(svc.setIntegrationRules).toHaveBeenCalledWith("/repo", {
      mergeBranch: "develop",
      branchPattern: "",
    });
    expect(svc.getIntegrationStatus).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Saved.");
    expect(button("Save")?.disabled).toBe(true);
  });

  it("goes back to the repository default by clearing the box", async () => {
    const custom = { ...DEFAULT_RULES, mergeBranch: "develop" };
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: activeStatus(custom) });
    svc.setIntegrationRules.mockResolvedValue({
      ok: true,
      value: activeStatus().project.binding,
    });
    await render();
    await click(button("Branch rules"));
    expect(mergeInput()?.value).toBe("develop");

    await typeBranch("");
    await click(button("Save"));
    expect(svc.setIntegrationRules).toHaveBeenCalledWith("/repo", {
      mergeBranch: "",
      branchPattern: "",
    });
  });

  it("shows a saved branch as it is, without asking the repository", async () => {
    const custom = { ...DEFAULT_RULES, mergeBranch: "old-branch" };
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: activeStatus(custom) });
    await render();
    await click(button("Branch rules"));

    expect(mergeInput()?.value).toBe("old-branch");
    expect(container.querySelector("[role=alert]")).toBeNull();
  });

  it("says the branch does not exist when saving is refused, and keeps what was typed", async () => {
    svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: activeStatus() });
    svc.setIntegrationRules.mockResolvedValue({
      ok: false,
      error: {
        code: "not_found",
        message: 'The repository has no branch named "develop".',
        hint: "Check the spelling. Branch names are case-sensitive.",
      },
    });
    await render();
    await click(button("Branch rules"));
    await typeBranch("develop");
    await click(button("Save"));

    expect(q("[role=alert]")?.textContent).toContain("has no branch named");
    expect(q("[role=alert]")?.textContent).toContain("case-sensitive");
    expect(container.textContent).not.toContain("Saved.");
    expect(mergeInput()?.value).toBe("develop");
    // Editing the branch clears the old complaint.
    await typeBranch("developer");
    expect(container.querySelector("[role=alert]")).toBeNull();
  });

  describe("branch naming (regex)", () => {
    const PATTERN = String.raw`^(feature|bugfix)/d+-[a-z0-9-]+$`;
    const prepare = async (rules: WorkflowRules = DEFAULT_RULES) => {
      svc.getIntegrationStatus.mockResolvedValue({ ok: true, value: activeStatus(rules) });
      svc.setIntegrationRules.mockResolvedValue({
        ok: true,
        value: activeStatus(rules).project.binding,
      });
      await render();
      await click(button("Branch rules"));
    };

    it("starts empty and shows no error before it is touched", async () => {
      await prepare({ ...DEFAULT_RULES, branchPattern: "^(" }); // a bad stored value
      expect(patternInput()?.value).toBe("^(");
      expect(container.textContent).not.toContain("Not a valid regular expression");
    });

    it("explains a broken pattern as you type and blocks saving", async () => {
      await prepare();
      await type("^feature/(");
      expect(container.textContent).toMatch(/Not a valid regular expression: .+./);
      expect(patternInput()?.getAttribute("aria-invalid")).toBe("true");
      expect(button("Save")?.disabled).toBe(true);

      await type(".*");
      expect(container.textContent).toContain("matches an empty name");

      await type(PATTERN);
      expect(container.textContent).not.toMatch(/Not a valid|matches an empty/);
      expect(patternInput()?.getAttribute("aria-invalid")).toBeNull();
      expect(button("Save")?.disabled).toBe(false);
    });

    it("only suggests anchors and still lets you save", async () => {
      await prepare();
      await type(String.raw`feature/d+`);
      expect(container.textContent).toContain("start with ^ and end with $");
      expect(button("Save")?.disabled).toBe(false);
    });

    it("saves the pattern together with the merge branch", async () => {
      await prepare();
      await typeBranch("develop");
      await type(PATTERN);
      await click(button("Save"));
      expect(svc.setIntegrationRules).toHaveBeenCalledWith("/repo", {
        mergeBranch: "develop",
        branchPattern: PATTERN,
      });
      expect(container.textContent).toContain("Saved.");
    });

    it("removes the pattern with its Remove button, then saves the removal", async () => {
      await prepare({ ...DEFAULT_RULES, mergeBranch: "develop", branchPattern: PATTERN });
      const remove = container.querySelector<HTMLButtonElement>(
        '[aria-label="Remove branch naming"]'
      );
      expect(remove?.disabled).toBe(false);
      await click(remove);
      expect(patternInput()?.value).toBe("");
      expect(mergeInput()?.value).toBe("develop"); // the other rule stays
      expect(
        container.querySelector<HTMLButtonElement>('[aria-label="Remove branch naming"]')?.disabled
      ).toBe(true);

      await click(button("Save"));
      expect(svc.setIntegrationRules).toHaveBeenCalledWith("/repo", {
        mergeBranch: "develop",
        branchPattern: "",
      });
    });

    it("removes the merge branch with its Remove button", async () => {
      await prepare({ ...DEFAULT_RULES, mergeBranch: "develop", branchPattern: PATTERN });
      await click(container.querySelector('[aria-label="Remove merge branch"]'));
      expect(mergeInput()?.value).toBe("");
      expect(patternInput()?.value).toBe(PATTERN);
      await click(button("Save"));
      expect(svc.setIntegrationRules).toHaveBeenCalledWith("/repo", {
        mergeBranch: "",
        branchPattern: PATTERN,
      });
    });

    it("keeps both Remove buttons off when nothing is set", async () => {
      await prepare();
      for (const label of ["Remove merge branch", "Remove branch naming"]) {
        expect(
          container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)?.disabled
        ).toBe(true);
      }
    });

    it("shows the server's reason when saving the pattern fails and keeps what was typed", async () => {
      await prepare();
      svc.setIntegrationRules.mockResolvedValue({
        ok: false,
        error: { code: "bad_request", message: "Pattern is too long (201 of 200 characters)." },
      });
      await type(PATTERN);
      await click(button("Save"));
      expect(q("[role=alert]")?.textContent).toContain("too long");
      expect(patternInput()?.value).toBe(PATTERN);
      expect(container.textContent).not.toContain("Saved.");
    });

    describe("a long pattern", () => {
      const count = () => q('[id$="-pattern-count"]');
      const long = (n: number) => "^" + "a".repeat(n - 2) + "$";

      it("is a wrapping box (not a one-line field) with a live count against the limit", async () => {
        await prepare();
        expect(patternInput()?.tagName).toBe("TEXTAREA");
        expect(patternInput()?.getAttribute("wrap")).toBe("soft");
        expect(count()?.textContent).toBe("0 / 200");
        await type(long(80));
        expect(count()?.textContent).toBe("80 / 200");
        expect(count()?.className).toContain("is-ok");
        expect(patternInput()?.getAttribute("aria-describedby")).toContain("pattern-count");
      });

      it("warns as it nears the limit and still saves right at it", async () => {
        await prepare();
        await type(long(190));
        expect(count()?.className).toContain("is-near");
        await type(long(200));
        expect(count()?.textContent).toBe("200 / 200");
        expect(button("Save")?.disabled).toBe(false);
        await click(button("Save"));
        expect(svc.setIntegrationRules).toHaveBeenCalledWith("/repo", {
          mergeBranch: "",
          branchPattern: long(200),
        });
      });

      it("says how far over it is, keeps what was typed and blocks saving", async () => {
        await prepare();
        await type(long(230));
        expect(count()?.textContent).toBe("230 / 200");
        expect(count()?.className).toContain("is-over");
        expect(container.textContent).toContain("Pattern is too long (230 of 200 characters).");
        expect(patternInput()?.value).toBe(long(230)); // nothing is silently cut off
        expect(patternInput()?.getAttribute("aria-invalid")).toBe("true");
        expect(button("Save")?.disabled).toBe(true);
        // Trimming it back under the limit clears the complaint.
        await type(long(150));
        expect(container.textContent).not.toContain("too long");
        expect(button("Save")?.disabled).toBe(false);
      });

      it("never takes a line break: Enter does nothing and a paste is flattened", async () => {
        await prepare();
        const box = patternInput()!;
        const enter = new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        });
        await act(async () => {
          box.dispatchEvent(enter);
        });
        expect(enter.defaultPrevented).toBe(true);
        await type("^feature/\r\n[a-z]+\n$");
        expect(patternInput()?.value).toBe("^feature/[a-z]+$");
      });

      it("shows a long saved pattern in full", async () => {
        await prepare({ ...DEFAULT_RULES, branchPattern: long(200) });
        expect(patternInput()?.value).toBe(long(200));
        expect(count()?.textContent).toBe("200 / 200");
        expect(container.textContent).not.toContain("too long");
      });
    });
  });
});
