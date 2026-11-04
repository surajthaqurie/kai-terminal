import type { IntegrationAuthMethod, ProviderInfo } from "./providerCatalog";
import type {
  DetectedCoordinates,
  IntegrationErrorBody,
  IntegrationErrorCode,
  IntegrationUser,
} from "./rpcTypes";
import type { SecretStore } from "./secretStore";
import type { WorkflowRules } from "./workflowRules";

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
  /** Workflow rules the user changed; anything absent uses its default. */
  rules?: Partial<WorkflowRules>;
  /**
   * The user allowed agents to change data in the service (comment, create a pull
   * request, change a state) for this project. Stored only when true; off by default,
   * and only a person at a terminal or in the desktop app can turn it on.
   */
  writeTools?: boolean;
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

/** What a write tool reports back: enough to find the change, never the secret or the whole body. */
export interface WorkItemCommentResult {
  workItemId: number;
  commentId?: number;
  url: string;
}

export interface WorkItemStateResult {
  workItemId: number;
  previousState?: string;
  state: string;
  url: string;
}

export interface PullRequestCommentResult {
  pullRequestId: number;
  threadId?: number;
  commentId?: number;
  url: string;
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

export interface PullRequestCreateInput {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description?: string;
  isDraft?: boolean;
}

export interface PullRequestCommentInput {
  id: number;
  text: string;
  /** Reply to this existing thread instead of starting a new one. */
  threadId?: number;
  /** Start the thread on a line of a changed file (both or neither). */
  filePath?: string;
  line?: number;
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
  /**
   * Parse a git remote URL into this provider's coordinates, or null. An address that
   * is only a guess (a self-hosted server's SSH remote) is flagged `needsConfirmation`.
   */
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
    /** Branch names (without `refs/heads/`) of one repository, sorted. */
    listBranches(
      account: IntegrationAccount,
      secrets: SecretStore,
      project: string,
      repo: string
    ): Promise<string[]>;
  };
  workItems?: {
    search(ctx: ProviderContext, q: WorkItemQuery): Promise<Page<WorkItemSummary>>;
    get(ctx: ProviderContext, id: number): Promise<WorkItemDetail>;
    /**
     * Writes. Optional, and only ever offered to an agent for a project whose user
     * turned write tools on. Each one changes data in the remote service.
     */
    addComment?(ctx: ProviderContext, id: number, text: string): Promise<WorkItemCommentResult>;
    setState?(ctx: ProviderContext, id: number, state: string): Promise<WorkItemStateResult>;
  };
  pullRequests?: {
    list(ctx: ProviderContext, q: PullRequestQuery): Promise<Page<PullRequestSummary>>;
    get(ctx: ProviderContext, id: number): Promise<PullRequestDetail>;
    /** Opens a pull request between two EXISTING branches; never creates a branch. */
    create?(ctx: ProviderContext, input: PullRequestCreateInput): Promise<PullRequestSummary>;
    addComment?(
      ctx: ProviderContext,
      input: PullRequestCommentInput
    ): Promise<PullRequestCommentResult>;
  };
  builds?: {
    list(ctx: ProviderContext, q: BuildQuery): Promise<Page<BuildSummary>>;
    log(ctx: ProviderContext, id: number, q: BuildLogQuery): Promise<BuildLogResult>;
  };
}

/** True when the provider can write at all (any write method exists). */
export function supportsWrites(provider: IntegrationProvider): boolean {
  return Boolean(
    provider.workItems?.addComment ||
    provider.workItems?.setState ||
    provider.pullRequests?.create ||
    provider.pullRequests?.addComment
  );
}

export function capabilitiesOf(provider: IntegrationProvider): Set<Capability> {
  const out = new Set<Capability>();
  if (provider.workItems) out.add("work-items");
  if (provider.pullRequests) out.add("pull-requests");
  if (provider.builds) out.add("builds");
  return out;
}
