import {
  parseTokenSet,
  serializeTokenSet,
  TOKEN_EXPIRY_MARGIN_MS,
  type OAuthDeps,
  type TokenSet,
} from "../integrations/providers/azure-devops/oauth";
import { defaultSecretStore, type SecretStore } from "../integrations/secretStore";
import { IntegrationError } from "../integrations/types";
import { saveTeamsAccount, teamsSecretKey, type TeamsAccount } from "./config";
import { CHANNEL_READ_SCOPE, refreshTeamsTokens, type TeamsSignIn } from "./oauth";

/**
 * The signed-in Teams user's tokens: read from the OS secret store, refreshed
 * shortly before they expire (the rotated refresh token is saved straight
 * away), and shared by concurrent callers so one refresh serves them all.
 */
export interface SessionOptions {
  account: TeamsAccount;
  secrets?: SecretStore;
  oauth?: OAuthDeps;
  now?: () => number;
}

export class TeamsSession {
  private readonly secrets: SecretStore;
  private inflight: Promise<string> | null = null;

  constructor(private readonly opts: SessionOptions) {
    this.secrets = opts.secrets ?? defaultSecretStore();
  }

  get account(): TeamsAccount {
    return this.opts.account;
  }

  /** True when the sign-in was granted permission to read channel messages. */
  get canReadChannels(): boolean {
    return this.opts.account.scopes.includes(CHANNEL_READ_SCOPE);
  }

  async accessToken(): Promise<string> {
    const key = teamsSecretKey(this.opts.account.id);
    const current = parseTokenSet(await this.secrets.get(key));
    if (!current) {
      throw new IntegrationError(
        "auth",
        "You are not signed in to Microsoft Teams.",
        "Run `kai integration teams` to sign in."
      );
    }
    const now = (this.opts.now ?? Date.now)();
    if (current.expiresAt - now > TOKEN_EXPIRY_MARGIN_MS) return current.accessToken;
    this.inflight ??= this.refresh(current, key).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async refresh(current: TokenSet, key: string): Promise<string> {
    const next = await refreshTeamsTokens(current, this.canReadChannels, this.opts.oauth ?? {});
    await this.secrets.set(key, serializeTokenSet(next));
    return next.accessToken;
  }
}

/** Save a finished sign-in: the token set in the secret store, who it is in config. */
export async function storeTeamsSignIn(
  signIn: TeamsSignIn,
  secrets: SecretStore = defaultSecretStore(),
  now: () => Date = () => new Date()
): Promise<{ account: TeamsAccount; storedIn: "os" | "file" }> {
  const account: TeamsAccount = {
    id: signIn.user.id,
    name: signIn.user.name,
    ...(signIn.user.email ? { email: signIn.user.email } : {}),
    scopes: signIn.scopes,
    signedInAt: now().toISOString(),
  };
  const storedIn = await secrets.set(teamsSecretKey(account.id), signIn.secret);
  saveTeamsAccount(account);
  return { account, storedIn };
}
