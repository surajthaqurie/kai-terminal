import { atomicWriteJson } from "../registry";
import { configPath, readConfigFile } from "../integrations/config";

/**
 * Who is signed in to Microsoft Teams lives in its own `teams` block of
 * `~/.kai/config.json`, apart from the project-bound `integrations` block: a
 * chat account belongs to the person, never to a folder or a repository.
 * Tokens are NOT here; they sit in the OS secret store (see session.ts).
 */

export interface TeamsAccount {
  /** Microsoft Entra object id of the signed-in user. */
  id: string;
  /** Display name. */
  name: string;
  email?: string;
  /** Delegated permissions the sign-in was granted (from the token). */
  scopes: string[];
  signedInAt: string;
}

function block(config: Record<string, unknown>): Record<string, unknown> {
  const t = config.teams;
  return typeof t === "object" && t !== null && !Array.isArray(t)
    ? (t as Record<string, unknown>)
    : {};
}

function parseAccount(v: unknown): TeamsAccount | null {
  if (typeof v !== "object" || v === null) return null;
  const a = v as Record<string, unknown>;
  if (typeof a.id !== "string" || !a.id || typeof a.name !== "string") return null;
  return {
    id: a.id,
    name: a.name,
    ...(typeof a.email === "string" && a.email ? { email: a.email } : {}),
    scopes: Array.isArray(a.scopes)
      ? a.scopes.filter((s): s is string => typeof s === "string")
      : [],
    signedInAt: typeof a.signedInAt === "string" ? a.signedInAt : "",
  };
}

/** The signed-in account, or null. */
export function getTeamsAccount(): TeamsAccount | null {
  return parseAccount(block(readConfigFile()).account);
}

export function saveTeamsAccount(account: TeamsAccount): void {
  const config = readConfigFile();
  // Keep the saved app registration: signing in again must not make people re-enter it.
  atomicWriteJson(configPath(), { ...config, teams: { ...block(config), account } });
}

/** Sign out. The saved Microsoft app ID stays: it belongs to this computer, not to the account. */
export function clearTeamsAccount(): void {
  const config = readConfigFile();
  if (!("teams" in config)) return;
  const { account: _account, ...kept } = block(config);
  const { teams: _teams, ...rest } = config;
  atomicWriteJson(configPath(), Object.keys(kept).length > 0 ? { ...rest, teams: kept } : rest);
}

/**
 * The Microsoft Entra app (client) ID saved on this computer with
 * `kai integration teams --client-id`, or null. It is a public client ID, not a secret.
 */
export function getSavedTeamsClientId(): string | null {
  const id = block(readConfigFile()).clientId;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

export function saveTeamsClientId(clientId: string): void {
  const config = readConfigFile();
  atomicWriteJson(configPath(), { ...config, teams: { ...block(config), clientId } });
}

/** Forget the saved app ID (and nothing else). */
export function clearSavedTeamsClientId(): void {
  const config = readConfigFile();
  const { clientId: _clientId, ...kept } = block(config);
  const { teams: _teams, ...rest } = config;
  atomicWriteJson(configPath(), Object.keys(kept).length > 0 ? { ...rest, teams: kept } : rest);
}

/** The secret-store key the account's token set is kept under. */
export function teamsSecretKey(accountId: string): string {
  return `kai/teams/${accountId}`;
}
