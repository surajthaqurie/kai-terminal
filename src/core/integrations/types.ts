import type { IntegrationAuthMethod, ProviderInfo } from "./providerCatalog";
import type {
  DetectedCoordinates,
  IntegrationErrorBody,
  IntegrationErrorCode,
  IntegrationUser,
} from "./rpcTypes";
import type { SecretStore } from "./secretStore";

export type { DetectedCoordinates, IntegrationUser };

/** A signed-in identity. Global: one account can serve many projects. */
export interface IntegrationAccount {
  /** `<provider>:<org>` lower-cased, e.g. `azure-devops:contoso`. */
  id: string;
  provider: string;
  org: string;
  /** Organization URL, no trailing slash. */
  baseUrl: string;
  authMethod: IntegrationAuthMethod;
  /** REST api-version the provider should send; the provider picks the default. */
  apiVersion?: string;
  user?: string;
  createdAt: string;
}

/**
 * What one project uses. A single object, never a list: a project cannot have
 * two active integrations by construction.
 */
export interface ProjectBinding {
  provider: string;
  account: string;
  project: string;
  repo: string | null;
  boundAt: string;
}

export class IntegrationError extends Error {
  readonly code: IntegrationErrorCode;
  readonly hint?: string;
  constructor(code: IntegrationErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "IntegrationError";
    this.code = code;
    this.hint = hint;
  }
  toBody(): IntegrationErrorBody {
    return { code: this.code, message: this.message, ...(this.hint ? { hint: this.hint } : {}) };
  }
}

export function asIntegrationError(err: unknown): IntegrationError {
  if (err instanceof IntegrationError) return err;
  return new IntegrationError("network", err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Provider-neutral shapes the MCP tools return. Providers map into these.
// ---------------------------------------------------------------------------

export interface Page<T> {
  items: T[];
  hasMore: boolean;
  nextOffset?: number;
}

export interface WorkItemSummary {
  id: number;
  type: string;
  title: string;
  state: string;
  assignedTo?: string;
  changedAt?: string;
  url: string;
}

export interface WorkItemRelation {
  kind: string;
  id?: number;
  title?: string;
  url?: string;
}

export interface Comment {
  author?: string;
  at?: string;
  text: string;
}

export interface WorkItemDetail extends WorkItemSummary {
  description?: string;
  acceptanceCriteria?: string;
  reproSteps?: string;
  tags: string[];
  priority?: number;
  areaPath?: string;
  iterationPath?: string;
  createdBy?: string;
  createdAt?: string;
  relations: WorkItemRelation[];
  comments: Comment[];
  /** Set when comments could not be loaded, so their absence is not read as "none". */
  commentsError?: string;
}

export interface PullRequestSummary {
  id: number;
  title: string;
  status: string;
  isDraft: boolean;
  author?: string;
  repo?: string;
  sourceBranch: string;
  targetBranch: string;
  createdAt?: string;
  url: string;
}

export interface PullRequestThread {
  id: number;
  status?: string;
  filePath?: string;
  line?: number;
  comments: Comment[];
}

export interface PullRequestDetail extends PullRequestSummary {
  description?: string;
  mergeStatus?: string;
  reviewers: Array<{ name: string; vote: string; required: boolean }>;
  changedFiles: Array<{ path: string; change: string }>;
  changedFilesTotal: number;
  /** True when the provider had more changed files than were fetched. */
  changedFilesTruncated?: boolean;
  threads: PullRequestThread[];
  threadsTotal: number;
}

export interface BuildSummary {
  id: number;
  number: string;
  definition?: string;
  status: string;
  result?: string;
  branch?: string;
  commit?: string;
  requestedBy?: string;
  startedAt?: string;
  finishedAt?: string;
  url: string;
}

export interface BuildLogInfo {
  id: number;
  lineCount?: number;
  type?: string;
}

export interface BuildFailure {
  step: string;
  logId?: number;
  issues: string[];
}

export interface BuildLogResult {
  build: BuildSummary;
  /** Failed steps with their error messages (only when no `logId` was asked for). */
  failures?: BuildFailure[];
  logs?: BuildLogInfo[];
  /** Log text for the requested `logId` and line window. */
  log?: { id: number; startLine: number; endLine: number; lineCount?: number; text: string };
}

export interface WorkItemQuery {
  text?: string;
  state?: string;
  type?: string;
  /** `me` or a display name / email. */
  assignedTo?: string;
  /** Raw read-only WIQL; overrides the structured filters. */
  wiql?: string;
  limit: number;
  offset: number;
}

export interface PullRequestQuery {
  status?: "active" | "completed" | "abandoned" | "all";
  /** Overrides the repository the project is bound to. */
  repo?: string;
  limit: number;
  offset: number;
}

export interface BuildQuery {
  status?: "inProgress" | "completed" | "notStarted" | "all";
  result?: "succeeded" | "failed" | "canceled" | "partiallySucceeded";
  branch?: string;
  limit: number;
  offset: number;
}

export interface BuildLogQuery {
  logId?: number;
  startLine?: number;
  endLine?: number;
}

/** Everything a provider call needs; assembled once per tool call. */
export interface ProviderContext {
  account: IntegrationAccount;
  binding: ProjectBinding;
  secrets: SecretStore;
}

export type Capability = "work-items" | "pull-requests" | "builds";

export interface ProjectInfo {
  name: string;
  description?: string;
}

export interface RepoInfo {
  name: string;
  defaultBranch?: string;
}

export interface IntegrationProvider {
  info: ProviderInfo;
  /** Parse a git remote URL into this provider's coordinates, or null. */
  detectFromRemote(url: string): DetectedCoordinates | null;
  /** Normalized account (id, baseUrl, apiVersion) for a login request. */
  buildAccount(input: {
    org?: string;
    baseUrl?: string;
    authMethod: IntegrationAuthMethod;
  }): Omit<IntegrationAccount, "createdAt" | "user">;
  /**
   * Sign in through the user's browser. Resolves with the credential to store, who
   * signed in, and every organization they can reach (so none has to be typed).
   */
  browserLogin?(opts: { onUrl?: (url: string) => void }): Promise<{
    secret: string;
    user: IntegrationUser;
    orgs: string[];
  }>;
  /** A real call that proves the credential works. */
  verify(
    account: IntegrationAccount,
    secrets: SecretStore,
    secret?: string
  ): Promise<IntegrationUser>;
  /** What an account can reach, so a project can be switched to a real one. Network calls. */
  discovery?: {
    listProjects(account: IntegrationAccount, secrets: SecretStore): Promise<ProjectInfo[]>;
    listRepos(
      account: IntegrationAccount,
      secrets: SecretStore,
      project: string
    ): Promise<RepoInfo[]>;
  };
  workItems?: {
    search(ctx: ProviderContext, q: WorkItemQuery): Promise<Page<WorkItemSummary>>;
    get(ctx: ProviderContext, id: number): Promise<WorkItemDetail>;
  };
  pullRequests?: {
    list(ctx: ProviderContext, q: PullRequestQuery): Promise<Page<PullRequestSummary>>;
    get(ctx: ProviderContext, id: number): Promise<PullRequestDetail>;
  };
  builds?: {
    list(ctx: ProviderContext, q: BuildQuery): Promise<Page<BuildSummary>>;
    log(ctx: ProviderContext, id: number, q: BuildLogQuery): Promise<BuildLogResult>;
  };
}

export function capabilitiesOf(provider: IntegrationProvider): Set<Capability> {
  const out = new Set<Capability>();
  if (provider.workItems) out.add("work-items");
  if (provider.pullRequests) out.add("pull-requests");
  if (provider.builds) out.add("builds");
  return out;
}
