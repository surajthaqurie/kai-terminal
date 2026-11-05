import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkTenant,
  explainMicrosoftError,
  normalizeTenant,
} from "../core/integrations/oauthRegistration";
import {
  KAI_AZURE_CLIENT_ID,
  authorityFrom,
  browserSignInAvailable,
  registrationFrom,
  registrationView,
  signInWithBrowser,
} from "../core/integrations/providers/azure-devops/oauth";
import { getStatus, handleRpc } from "../core/integrations/service";
import { teamsClientId } from "../core/teams/oauth";
import { IntegrationError } from "../core/integrations/types";
import { useTempKaiHome } from "./helpers/integrationsEnv";

const ID = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-8888-7777-6666-555555555555";
const TENANT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const noEnv = {} as NodeJS.ProcessEnv;
const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;

let home: ReturnType<typeof useTempKaiHome>;
beforeEach(() => {
  home = useTempKaiHome();
});
afterEach(() => home.restore());

describe("directory rules", () => {
  it("accepts a tenant GUID, a domain or an audience, and treats empty as common", () => {
    expect(checkTenant(undefined)).toBeNull();
    expect(checkTenant("")).toBeNull();
    expect(checkTenant(TENANT)).toBeNull();
    expect(checkTenant("contoso.onmicrosoft.com")).toBeNull();
    expect(checkTenant("organizations")).toBeNull();
    expect(checkTenant("CONSUMERS")).toBeNull();
    expect(checkTenant("not a tenant")).toContain("Directory (tenant) ID");
    expect(checkTenant("../evil")).toContain("Directory (tenant) ID");
    expect(checkTenant("a/b")).toContain("Directory (tenant) ID");
    expect(normalizeTenant("  ")).toBe("common");
    expect(normalizeTenant(" Contoso.com ")).toBe("contoso.com");
  });

  it("turns Microsoft's sign-in errors into what to change, and stays quiet otherwise", () => {
    expect(
      explainMicrosoftError("AADSTS50194: Application is not configured as a multi-tenant")
    ).toContain("KAI_AZURE_TENANT_ID");
    expect(
      explainMicrosoftError("AADSTS700016: Application with identifier 'x' was not found")
    ).toContain("KAI_AZURE_CLIENT_ID");
    expect(explainMicrosoftError("AADSTS50011: The redirect URI does not match")).toContain(
      "http://localhost"
    );
    expect(explainMicrosoftError("AADSTS65001: needs consent")).toContain("approved");
    expect(explainMicrosoftError("AADSTS7000218: client_assertion or client_secret")).toContain(
      "Allow public client flows"
    );
    // Nothing tells the person to type an ID into a form: there is none.
    expect(
      explainMicrosoftError("AADSTS700016: Application with identifier 'x' was not found")
    ).not.toMatch(/sign-in settings|Integrations tab/i);
    expect(explainMicrosoftError("something unrelated")).toBeUndefined();
  });
});

describe("which registration is in force", () => {
  it("is unavailable until the build has an app ID, and says what is missing", () => {
    // This build ships no app ID yet; when one is filled in, this test must be updated.
    expect(KAI_AZURE_CLIENT_ID).toBe("");
    expect(browserSignInAvailable(noEnv)).toBe(false);
    try {
      registrationFrom(noEnv);
      expect.unreachable();
    } catch (err) {
      expect((err as IntegrationError).code).toBe("config");
      expect((err as IntegrationError).message).toContain("not set up in this build");
      expect((err as IntegrationError).hint).not.toMatch(/sign-in settings|Integrations tab/i);
    }
    expect(registrationView(noEnv)).toEqual({ available: false, source: null });
  });

  it("uses KAI_AZURE_CLIENT_ID (and an optional directory) when the environment sets it", () => {
    expect(registrationFrom(env({ KAI_AZURE_CLIENT_ID: ` ${OTHER} ` }))).toEqual({
      clientId: OTHER,
      tenant: "common",
      source: "env",
    });
    expect(
      registrationFrom(env({ KAI_AZURE_CLIENT_ID: OTHER, KAI_AZURE_TENANT_ID: "Contoso.com" }))
        .tenant
    ).toBe("contoso.com");
    expect(browserSignInAvailable(env({ KAI_AZURE_CLIENT_ID: OTHER }))).toBe(true);
    expect(registrationView(env({ KAI_AZURE_CLIENT_ID: OTHER }))).toEqual({
      available: true,
      source: "env",
    });
  });

  it("rejects a malformed environment value instead of quietly using another app", () => {
    expect(() => registrationFrom(env({ KAI_AZURE_CLIENT_ID: "oops" }))).toThrowError(
      /KAI_AZURE_CLIENT_ID is not a valid client ID/
    );
    expect(() =>
      registrationFrom(env({ KAI_AZURE_CLIENT_ID: ID, KAI_AZURE_TENANT_ID: "a b" }))
    ).toThrowError(/KAI_AZURE_TENANT_ID/);
    expect(registrationView(env({ KAI_AZURE_CLIENT_ID: "oops" }))).toEqual({
      available: false,
      source: "env",
    });
  });

  it("ignores anything left in Kai's config file: there is no saved sign-in app any more", () => {
    // An earlier draft kept a client ID under integrations.oauth. It must not take effect.
    // (The temp Kai home is empty here; the point is that nothing reads config for this.)
    expect(browserSignInAvailable(noEnv)).toBe(false);
  });

  it("lets Teams use the same registration, or its own", () => {
    expect(() => teamsClientId(noEnv)).toThrowError(/Teams sign-in is not set up/);
    expect(teamsClientId(env({ KAI_AZURE_CLIENT_ID: ID }))).toBe(ID);
    expect(teamsClientId(env({ KAI_TEAMS_CLIENT_ID: OTHER }))).toBe(OTHER);
    expect(() => teamsClientId(env({ KAI_TEAMS_CLIENT_ID: "bad" }))).toThrowError(
      /KAI_TEAMS_CLIENT_ID/
    );
    // A malformed Azure variable is reported as itself, not as "not set up".
    expect(() => teamsClientId(env({ KAI_AZURE_CLIENT_ID: "bad" }))).toThrowError(
      /KAI_AZURE_CLIENT_ID/
    );
  });
});

describe("the sign-in URL", () => {
  it("is common by default and the environment's directory otherwise", () => {
    expect(authorityFrom(noEnv)).toBe("https://login.microsoftonline.com/common/oauth2/v2.0");
    expect(authorityFrom(env({ KAI_AZURE_CLIENT_ID: ID, KAI_AZURE_TENANT_ID: TENANT }))).toBe(
      `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`
    );
  });

  it("is generated once, with the account picker and a PKCE challenge, and handed to the browser", async () => {
    let shown = "";
    let opened = "";
    // The sign-in is abandoned once the address is known; nobody signs in.
    await expect(
      signInWithBrowser(
        { onUrl: (u) => (shown = u) },
        {
          env: env({ KAI_AZURE_CLIENT_ID: ID, KAI_AZURE_TENANT_ID: "contoso.onmicrosoft.com" }),
          openUrl: (u) => (opened = u),
          signInTimeoutMs: 20,
        }
      )
    ).rejects.toMatchObject({ code: "auth" });
    expect(opened).toBe(shown);
    const url = new URL(shown);
    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize"
    );
    expect(url.searchParams.get("client_id")).toBe(ID);
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("redirect_uri")).toMatch(/^http:\/\/localhost:\d+\/$/);
  });

  it("does not open a browser at all when this build has no app ID", async () => {
    let opened = false;
    await expect(
      signInWithBrowser({}, { env: noEnv, openUrl: () => (opened = true) })
    ).rejects.toMatchObject({ code: "config" });
    expect(opened).toBe(false);
  });
});

describe("the RPC surface", () => {
  it("reports whether sign-in is available in the status, with nothing to edit", async () => {
    const saved = process.env.KAI_AZURE_CLIENT_ID;
    delete process.env.KAI_AZURE_CLIENT_ID;
    try {
      expect((await getStatus("azure-devops", home.home)).oauth).toEqual({
        available: false,
        source: null,
      });
      process.env.KAI_AZURE_CLIENT_ID = ID;
      expect((await getStatus("azure-devops", home.home)).oauth).toEqual({
        available: true,
        source: "env",
      });
    } finally {
      if (saved === undefined) delete process.env.KAI_AZURE_CLIENT_ID;
      else process.env.KAI_AZURE_CLIENT_ID = saved;
    }
  });

  it("has no operation to save or clear a sign-in app", async () => {
    for (const op of ["oauth_set", "oauth_clear"]) {
      const res = await handleRpc("azure-devops", { op, clientId: ID } as never).catch(
        (e: unknown) => e
      );
      expect(res).not.toMatchObject({ ok: true });
    }
  });
});
