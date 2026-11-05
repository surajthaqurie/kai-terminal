/**
 * The Microsoft Entra app registration that browser sign-in uses.
 *
 * Kai signs people in through ONE app registration that ships with the build: a
 * public client (no secret), so its ID is a plain constant. People never enter it.
 * For CI and for testing a registration, `KAI_AZURE_CLIENT_ID` (and, for a
 * single-tenant app, `KAI_AZURE_TENANT_ID`) override it. Pure rules only (no Node
 * imports), shared by the desktop UI and the CLI.
 */

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `contoso.onmicrosoft.com`, `contoso.com`: a verified domain also names a directory. */
const DOMAIN = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
/** Entra's built-in audiences. `common` is the default: any work or personal account. */
const AUDIENCES = ["common", "organizations", "consumers"] as const;

export const DEFAULT_TENANT = "common";

/** Where the registration in force came from: an environment variable, or the build itself. */
export type RegistrationSource = "env" | "build";

export interface OAuthRegistrationView {
  /** True when browser sign-in can start. */
  available: boolean;
  source: RegistrationSource | null;
}

export function isGuid(value: string): boolean {
  return GUID.test(value);
}

/** The tenant as used: lower-cased, and empty/`common` both mean the default. */
export function normalizeTenant(raw: string | undefined | null): string {
  const tenant = (raw ?? "").trim().toLowerCase();
  return tenant || DEFAULT_TENANT;
}

export function checkTenant(raw: string | undefined | null): string | null {
  const tenant = normalizeTenant(raw);
  if (GUID.test(tenant) || DOMAIN.test(tenant)) return null;
  if ((AUDIENCES as readonly string[]).includes(tenant)) return null;
  return "Use the Directory (tenant) ID (a GUID), a domain such as contoso.onmicrosoft.com, or leave it unset.";
}

/** True when Microsoft's text says an administrator has to approve the access first. */
export function needsAdminApproval(text: string): boolean {
  return /AADSTS90094|AADSTS650057|admin(istrator)?\s+(consent|approval|permission)|requires admin|need admin approval/i.test(
    text
  );
}

/** What a person is told when only an administrator can approve what was asked for. */
export const ADMIN_APPROVAL_MESSAGE =
  "Your organization needs an administrator to approve this access.";

/**
 * What Microsoft's sign-in error text means for the person, in terms of this
 * setup. `undefined` when the text is not one we recognize, so nothing is invented.
 */
export function explainMicrosoftError(text: string): string | undefined {
  if (/AADSTS50194|not configured as a multi-?tenant|single-?tenant/i.test(text)) {
    return "Kai's sign-in app is single-tenant. Set KAI_AZURE_TENANT_ID to your Directory (tenant) ID, or change the app registration to accept accounts in any organizational directory.";
  }
  if (/AADSTS700016|application with identifier .* was not found/i.test(text)) {
    return "Microsoft does not know Kai's sign-in app in this directory. If KAI_AZURE_CLIENT_ID is set, check it; otherwise this build of Kai has the wrong app ID (docs/azure-devops-sign-in.md).";
  }
  if (/AADSTS50011|redirect uri|reply url/i.test(text)) {
    return "Add http://localhost as a redirect URI under Mobile and desktop applications in the app registration.";
  }
  if (/AADSTS65001|consent/i.test(text)) {
    return "This account has not approved the app yet. Sign in again and accept the permissions, or ask an administrator to approve it.";
  }
  if (/AADSTS7000218|client_assertion|client_secret/i.test(text)) {
    return "Turn on Allow public client flows (Authentication) in the app registration: Kai has no client secret.";
  }
  if (/AADSTS90002|tenant .* not found|AADSTS900023/i.test(text)) {
    return "That Directory (tenant) ID was not found. Check KAI_AZURE_TENANT_ID.";
  }
  return undefined;
}
