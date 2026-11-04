import { httpRequest, type HttpDeps, type HttpResponse } from "../../http";
import { clipText } from "../../format";
import {
  IntegrationError,
  type BuildLogQuery,
  type BuildLogResult,
  type BuildQuery,
  type BuildSummary,
  type IntegrationAccount,
  type IntegrationProvider,
  type IntegrationUser,
  type Page,
  type ProjectInfo,
  type ProviderContext,
  type PullRequestCommentInput,
  type PullRequestCommentResult,
  type PullRequestCreateInput,
  type PullRequestDetail,
  type PullRequestQuery,
  type PullRequestSummary,
  type RepoInfo,
  type WorkItemCommentResult,
  type WorkItemDetail,
  type WorkItemQuery,
  type WorkItemStateResult,
  type WorkItemSummary,
} from "../../types";
import { findProvider } from "../../providerCatalog";
import type { SecretStore } from "../../secretStore";
import { authHeaderFor, loginHintFor, type AuthDeps } from "./auth";
import { signInWithBrowser } from "./oauth";
import {
  assertWiqlProjectScope,
  buildWiql,
  identityName,
  mapBuild,
  mapComments,
  mapFailures,
  mapPullRequest,
  mapReviewers,
  mapThreads,
  mapWorkItemDetail,
  mapWorkItemSummary,
  workItemUrl,
} from "./mapper";
import { parseAzureRemote } from "./remote";

const info = findProvider("azure-devops")!;

const CLOUD_API_VERSION = "7.1";
const SERVER_API_VERSION = "7.0";
/** The comments API is preview-only; its preview number differs between 7.1 (services) and 7.0 (server). */
const COMMENTS_API_SUFFIX: Record<string, string> = { "7.1": "-preview.4", "7.0": "-preview.3" };
const WORK_ITEM_FIELDS = [
  "System.Id",
  "System.WorkItemType",
  "System.Title",
  "System.State",
  "System.AssignedTo",
  "System.ChangedDate",
  "System.TeamProject",
];
const MAX_CHANGED_FILES = 200;
const MAX_LOG_LINES = 400;
const DEFAULT_LOG_TAIL = 150;
const MAX_LOG_CHARS = 24_000;
const DISCOVERY_PAGE = 100;
const MAX_DISCOVERY_ROWS = 500;

/** What a refused write says, so a token that can read but not write is not a mystery. */
const WRITE_TOKEN_HINT =
  "Changing data needs a token with Work Items (Read & write) and Code (Read & write). Create one, then run `kai integration azure` again. (Browser and Azure CLI sign-ins use your own Azure DevOps permissions.)";
const WRITE_PERMISSION_HINT =
  "Your Azure DevOps account may not be allowed to make this change in this project.";

/** Test seam: inject fetch, sleep and the Azure CLI runner. */
export interface AzureDeps {
  http?: HttpDeps;
  auth?: AuthDeps;
}

type Query = Record<string, string | number | undefined>;

const enc = encodeURIComponent;

/** The organization of a cloud address (`dev.azure.com/<org>`, `<org>.visualstudio.com`), else null. */
function cloudOrgOf(address: string): string | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host === "dev.azure.com") return url.pathname.split("/").filter(Boolean)[0] ?? null;
  if (host.endsWith(".visualstudio.com")) return host.slice(0, -".visualstudio.com".length) || null;
  return null;
}

function apiVersionOf(account: IntegrationAccount): string {
  return account.apiVersion ?? CLOUD_API_VERSION;
}

function withQuery(url: string, query: Query): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

class AzureCall {
  constructor(
    private readonly account: IntegrationAccount,
    private readonly secrets: SecretStore,
    private readonly deps: AzureDeps,
    private readonly patOverride?: string
  ) {}

  get base(): string {
    return this.account.baseUrl;
  }

  private async send(
    url: string,
    opts: {
      method?: "GET" | "POST" | "PATCH";
      body?: unknown;
      accept?: string;
      contentType?: string;
    }
  ): Promise<HttpResponse> {
    const auth = await authHeaderFor(this.account, this.secrets, this.deps.auth, this.patOverride);
    return httpRequest(
      {
        url,
        method: opts.method,
        body: opts.body,
        accept: opts.accept,
        headers: {
          authorization: auth.header,
          ...(opts.contentType ? { "content-type": opts.contentType } : {}),
        },
        redact: [auth.secret],
        authHint: loginHintFor(this.account),
      },
      this.deps.http
    );
  }

  async get<T>(path: string, query: Query = {}, apiVersion?: string): Promise<T> {
    const url = withQuery(`${this.base}/${path}`, {
      ...query,
      "api-version": apiVersion ?? apiVersionOf(this.account),
    });
    return (await this.send(url, {})).json<T>();
  }

  async post<T>(path: string, body: unknown, query: Query = {}, apiVersion?: string): Promise<T> {
    const url = withQuery(`${this.base}/${path}`, {
      ...query,
      "api-version": apiVersion ?? apiVersionOf(this.account),
    });
    return (await this.send(url, { method: "POST", body })).json<T>();
  }

  /** A JSON Patch (work item fields). */
  async patch<T>(path: string, operations: unknown[]): Promise<T> {
    const url = withQuery(`${this.base}/${path}`, { "api-version": apiVersionOf(this.account) });
    return (
      await this.send(url, {
        method: "PATCH",
        body: operations,
        contentType: "application/json-patch+json",
      })
    ).json<T>();
  }

  async getText(path: string, query: Query = {}): Promise<string> {
    const url = withQuery(`${this.base}/${path}`, {
      ...query,
      "api-version": apiVersionOf(this.account),
    });
    return (await this.send(url, { accept: "text/plain" })).text;
  }
}

function call(ctx: ProviderContext, deps: AzureDeps): AzureCall {
  return new AzureCall(ctx.account, ctx.secrets, deps);
}

function page<T>(rows: T[], limit: number, offset: number): Page<T> {
  const items = rows.slice(offset, offset + limit);
  const hasMore = rows.length > offset + limit;
  return { items, hasMore, ...(hasMore ? { nextOffset: offset + limit } : {}) };
}

type Json = Record<string, unknown>;
const list = (raw: unknown, key = "value"): unknown[] => {
  const v = (raw as Json | undefined)?.[key];
  return Array.isArray(v) ? v : [];
};

const commentsApiVersion = (account: IntegrationAccount): string =>
  `${apiVersionOf(account)}${COMMENTS_API_SUFFIX[apiVersionOf(account)] ?? "-preview.4"}`;

/**
 * A work item comment is HTML on the wire: escape what the agent wrote, so markup in it
 * is shown as text, and keep its line breaks.
 */
export function commentHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r?\n/g, "<br>");
}

/** Adds the write-specific hint to a refusal; every other error passes through unchanged. */
async function writing<T>(account: IntegrationAccount, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof IntegrationError && (err.code === "forbidden" || err.code === "auth")) {
      throw new IntegrationError(
        err.code,
        err.message,
        account.authMethod === "pat" ? WRITE_TOKEN_HINT : WRITE_PERMISSION_HINT
      );
    }
    throw err;
  }
}

/**
 * The work item's current fields, but only when it is in the bound project: an id from
 * another project fails closed with the same `not_found` a read gives, before anything is written.
 */
async function requireProjectWorkItem(
  c: AzureCall,
  project: string,
  id: number
): Promise<{ state?: string; rev?: number }> {
  const raw = await c.get<Json>(`${enc(project)}/_apis/wit/workitems/${id}`, {
    fields: "System.TeamProject,System.State,System.Rev",
  });
  const fields =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw.fields as Record<string, unknown> | undefined)
      : undefined;
  const itemProject =
    fields && typeof fields === "object" ? fields["System.TeamProject"] : undefined;
  if (
    typeof itemProject !== "string" ||
    !itemProject.trim() ||
    itemProject.trim().toLowerCase() !== project.trim().toLowerCase()
  ) {
    throw new IntegrationError("not_found", `Work item ${id} was not found.`);
  }
  const state = fields?.["System.State"];
  return {
    state: typeof state === "string" ? state : undefined,
    rev: typeof raw.rev === "number" ? raw.rev : undefined,
  };
}

/** The pull request, but only when its repository is in the bound project (fails closed). */
async function requireProjectPullRequest(c: AzureCall, project: string, id: number): Promise<Json> {
  const raw = await c.get<Json>(`${enc(project)}/_apis/git/pullrequests/${id}`);
  const repo = (raw?.repository ?? {}) as Json;
  const repoProject = ((repo.project ?? {}) as Json).name;
  if (
    typeof repoProject !== "string" ||
    repoProject.trim().toLowerCase() !== project.trim().toLowerCase() ||
    typeof repo.id !== "string"
  ) {
    throw new IntegrationError("not_found", `Pull request ${id} was not found.`);
  }
  return raw;
}

export function createAzureDevOpsProvider(deps: AzureDeps = {}): IntegrationProvider {
  async function fetchWorkItems(
    c: AzureCall,
    project: string,
    ids: number[]
  ): Promise<WorkItemSummary[]> {
    if (ids.length === 0) return [];
    const raw = await c.post<{ value?: unknown[] }>(`${enc(project)}/_apis/wit/workitemsbatch`, {
      ids,
      fields: WORK_ITEM_FIELDS,
    });
    const byId = new Map<number, WorkItemSummary>();
    const normalizedProject = project.trim().toLowerCase();
    for (const w of list(raw)) {
      const item = w as Json | undefined;
      const f = (item?.fields ?? {}) as Json;
      const itemProj =
        typeof f["System.TeamProject"] === "string" ? f["System.TeamProject"].trim() : "";
      if (itemProj && itemProj.toLowerCase() !== normalizedProject) {
        continue;
      }
      const s = mapWorkItemSummary(w, c.base, project);
      byId.set(s.id, s);
    }
    return ids.map((id) => byId.get(id)).filter((w): w is WorkItemSummary => Boolean(w));
  }

  return {
    info,

    detectFromRemote: parseAzureRemote,

    browserLogin: (opts) => signInWithBrowser(opts, { env: deps.auth?.env, ...deps.auth?.oauth }),

    buildAccount({ org, baseUrl, authMethod }) {
      // A cloud address is the same account as `--org <name>`, however it was spelled.
      const cloudOrg = baseUrl ? cloudOrgOf(baseUrl) : null;
      if (baseUrl && !cloudOrg) {
        let parsed: URL;
        try {
          parsed = new URL(baseUrl);
        } catch {
          throw new IntegrationError("bad_request", "The server URL is not a valid URL.");
        }
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
          throw new IntegrationError("bad_request", "The server URL must be http or https.");
        }
        const path = parsed.pathname.replace(/\/+$/, "");
        const normalized = `${parsed.origin}${path}`;
        const key = `${parsed.host}${path}`.toLowerCase();
        return {
          id: `${info.id}:${key}`,
          provider: info.id,
          org: path.split("/").filter(Boolean).pop() ?? parsed.host,
          baseUrl: normalized,
          authMethod,
          apiVersion: SERVER_API_VERSION,
        };
      }
      const name = (cloudOrg ?? org ?? "").trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
        throw new IntegrationError(
          "bad_request",
          "Enter the organization name, the part after dev.azure.com/.",
          "Example: kai integration azure --org contoso"
        );
      }
      return {
        id: `${info.id}:${name.toLowerCase()}`,
        provider: info.id,
        org: name,
        baseUrl: `https://dev.azure.com/${name}`,
        authMethod,
        apiVersion: CLOUD_API_VERSION,
      };
    },

    async verify(account, secrets, secret): Promise<IntegrationUser> {
      const c = new AzureCall(account, secrets, deps, secret);
      const raw = await c.get<Json>("_apis/connectionData", {}, `${apiVersionOf(account)}-preview`);
      const user = (raw.authenticatedUser ?? {}) as Json;
      const props = (user.properties ?? {}) as Json;
      const email = (props.Account as Json | undefined)?.$value;
      const name = identityName({ displayName: user.providerDisplayName }) ?? "signed-in user";
      return { name, ...(typeof email === "string" ? { email } : {}) };
    },

    discovery: {
      async listProjects(account, secrets) {
        const c = new AzureCall(account, secrets, deps);
        const out: ProjectInfo[] = [];
        for (let skip = 0; skip < MAX_DISCOVERY_ROWS; skip += DISCOVERY_PAGE) {
          const raw = await c.get<Json>("_apis/projects", { $top: DISCOVERY_PAGE, $skip: skip });
          const rows = list(raw);
          for (const row of rows) {
            const o = row as Json;
            if (typeof o.name !== "string") continue;
            out.push({
              name: o.name,
              ...(typeof o.description === "string" && o.description
                ? { description: clipText(o.description, 120) }
                : {}),
            });
          }
          if (rows.length < DISCOVERY_PAGE) break;
        }
        return out.sort((a, b) => a.name.localeCompare(b.name));
      },

      async listRepos(account, secrets, project) {
        const c = new AzureCall(account, secrets, deps);
        const raw = await c.get<Json>(`${enc(project)}/_apis/git/repositories`);
        const out: RepoInfo[] = [];
        for (const row of list(raw).slice(0, MAX_DISCOVERY_ROWS)) {
          const o = row as Json;
          if (typeof o.name !== "string" || o.isDisabled === true) continue;
          out.push({
            name: o.name,
            ...(typeof o.defaultBranch === "string"
              ? { defaultBranch: o.defaultBranch.replace(/^refs\/heads\//, "") }
              : {}),
          });
        }
        return out.sort((a, b) => a.name.localeCompare(b.name));
      },

      async listBranches(account, secrets, project, repo) {
        const c = new AzureCall(account, secrets, deps);
        const raw = await c.get<Json>(`${enc(project)}/_apis/git/repositories/${enc(repo)}/refs`, {
          filter: "heads/",
          $top: MAX_DISCOVERY_ROWS,
        });
        const out: string[] = [];
        for (const row of list(raw)) {
          const name = (row as Json).name;
          if (typeof name === "string" && name.startsWith("refs/heads/")) {
            out.push(name.slice("refs/heads/".length));
          }
        }
        return out.sort((a, b) => a.localeCompare(b));
      },
    },

    workItems: {
      async search(ctx, q: WorkItemQuery): Promise<Page<WorkItemSummary>> {
        const c = call(ctx, deps);
        const project = ctx.binding.project;
        let query: string;
        if (q.wiql) {
          if (!/^\s*select\s/i.test(q.wiql) || q.wiql.length > 2000) {
            throw new IntegrationError(
              "bad_request",
              "wiql must be a SELECT query of at most 2000 characters."
            );
          }
          assertWiqlProjectScope(q.wiql, project);
          query = q.wiql;
        } else {
          query = buildWiql(q);
        }
        const wanted = q.offset + q.limit;
        const result = await c.post<{ workItems?: Array<{ id: number }> }>(
          `${enc(project)}/_apis/wit/wiql`,
          { query },
          { $top: wanted + 1 }
        );
        const ids = (result.workItems ?? []).map((w) => w.id);
        const { items, hasMore, nextOffset } = page(ids, q.limit, q.offset);
        return {
          items: await fetchWorkItems(c, project, items),
          hasMore,
          ...(nextOffset !== undefined ? { nextOffset } : {}),
        };
      },

      async get(ctx, id): Promise<WorkItemDetail> {
        const c = call(ctx, deps);
        const project = ctx.binding.project;
        const raw = await c.get<Json>(`${enc(project)}/_apis/wit/workitems/${id}`, {
          $expand: "relations",
        });

        // Verify project boundary before mapping or returning any details
        const fields =
          raw && typeof raw === "object" && !Array.isArray(raw)
            ? (raw.fields as Record<string, unknown> | undefined)
            : undefined;
        const itemProject =
          fields && typeof fields === "object" && !Array.isArray(fields)
            ? fields["System.TeamProject"]
            : undefined;

        // Fail closed if project identity is missing, malformed, or targets another project
        if (typeof itemProject !== "string" || !itemProject.trim()) {
          throw new IntegrationError("not_found", `Work item ${id} was not found.`);
        }

        if (itemProject.trim().toLowerCase() !== project.trim().toLowerCase()) {
          throw new IntegrationError("not_found", `Work item ${id} was not found.`);
        }

        const detail = mapWorkItemDetail(raw, c.base, project);
        try {
          const comments = await c.get<Json>(
            `${enc(project)}/_apis/wit/workItems/${id}/comments`,
            { $top: 20, order: "desc" },
            `${apiVersionOf(ctx.account)}${COMMENTS_API_SUFFIX[apiVersionOf(ctx.account)] ?? "-preview.4"}`
          );
          return { ...detail, comments: mapComments(comments) };
        } catch (err) {
          // Comments are a preview API; the work item itself is still useful without them.
          return {
            ...detail,
            comments: [],
            commentsError: clipText(err instanceof Error ? err.message : "failed", 160),
          };
        }
      },

      async addComment(ctx, id, text): Promise<WorkItemCommentResult> {
        const c = call(ctx, deps);
        const project = ctx.binding.project;
        return writing(ctx.account, async () => {
          await requireProjectWorkItem(c, project, id);
          const raw = await c.post<Json>(
            `${enc(project)}/_apis/wit/workItems/${id}/comments`,
            { text: commentHtml(text) },
            {},
            commentsApiVersion(ctx.account)
          );
          return {
            workItemId: id,
            ...(typeof raw.id === "number" ? { commentId: raw.id } : {}),
            url: workItemUrl(c.base, project, id),
          };
        });
      },

      async setState(ctx, id, state): Promise<WorkItemStateResult> {
        const c = call(ctx, deps);
        const project = ctx.binding.project;
        return writing(ctx.account, async () => {
          const before = await requireProjectWorkItem(c, project, id);
          const operations: unknown[] = [];
          // Refuse to overwrite a change made since the state above was read.
          if (before.rev !== undefined) {
            operations.push({ op: "test", path: "/rev", value: before.rev });
          }
          operations.push({ op: "add", path: "/fields/System.State", value: state });
          const raw = await c.patch<Json>(`${enc(project)}/_apis/wit/workitems/${id}`, operations);
          const now = ((raw.fields ?? {}) as Json)["System.State"];
          return {
            workItemId: id,
            ...(before.state ? { previousState: before.state } : {}),
            state: typeof now === "string" ? now : state,
            url: workItemUrl(c.base, project, id),
          };
        });
      },
    },

    pullRequests: {
      async list(ctx, q: PullRequestQuery): Promise<Page<PullRequestSummary>> {
        const c = call(ctx, deps);
        const project = ctx.binding.project;
        const repo = q.repo ?? ctx.binding.repo;
        const path = repo
          ? `${enc(project)}/_apis/git/repositories/${enc(repo)}/pullrequests`
          : `${enc(project)}/_apis/git/pullrequests`;
        const raw = await c.get<Json>(path, {
          "searchCriteria.status": q.status ?? "active",
          $top: q.limit + 1,
          $skip: q.offset,
        });
        const rows = list(raw).map((p) => mapPullRequest(p, c.base, project));
        const hasMore = rows.length > q.limit;
        return {
          items: rows.slice(0, q.limit),
          hasMore,
          ...(hasMore ? { nextOffset: q.offset + q.limit } : {}),
        };
      },

      async get(ctx, id): Promise<PullRequestDetail> {
        const c = call(ctx, deps);
        const project = ctx.binding.project;
        const raw = await c.get<Json>(`${enc(project)}/_apis/git/pullrequests/${id}`);
        const summary = mapPullRequest(raw, c.base, project);
        const repoId = ((raw.repository ?? {}) as Json).id;
        if (typeof repoId !== "string") {
          throw new IntegrationError("bad_request", "The pull request has no repository.");
        }
        const prPath = `${enc(project)}/_apis/git/repositories/${enc(repoId)}/pullrequests/${id}`;

        const [iterations, threadsRaw] = await Promise.all([
          c.get<Json>(`${prPath}/iterations`),
          c.get<Json>(`${prPath}/threads`),
        ]);
        const last = Math.max(0, ...list(iterations).map((i) => Number((i as Json).id) || 0));
        let changedFiles: Array<{ path: string; change: string }> = [];
        let truncated = false;
        if (last > 0) {
          const changes = await c.get<Json>(`${prPath}/iterations/${last}/changes`, {
            $top: MAX_CHANGED_FILES,
          });
          changedFiles = list(changes, "changeEntries").map((e) => {
            const entry = e as Json;
            return {
              path: String(((entry.item ?? {}) as Json).path ?? "").replace(/^\//, ""),
              change: String(entry.changeType ?? "edit"),
            };
          });
          truncated = Number(changes.nextSkip) > 0 || changedFiles.length >= MAX_CHANGED_FILES;
        }
        const { threads, total } = mapThreads(threadsRaw);
        return {
          ...summary,
          description: clipText(String(raw.description ?? ""), 4000) || undefined,
          mergeStatus: typeof raw.mergeStatus === "string" ? raw.mergeStatus : undefined,
          reviewers: mapReviewers(raw.reviewers),
          changedFiles,
          changedFilesTotal: changedFiles.length,
          ...(truncated ? { changedFilesTruncated: true } : {}),
          threads,
          threadsTotal: total,
        };
      },

      async create(ctx, input: PullRequestCreateInput): Promise<PullRequestSummary> {
        const c = call(ctx, deps);
        const project = ctx.binding.project;
        const repo = ctx.binding.repo;
        if (!repo) {
          throw new IntegrationError(
            "bad_request",
            "This project is not bound to a repository.",
            "Pick one first: `kai azure active --repo <name>`."
          );
        }
        return writing(ctx.account, async () => {
          // Opens a pull request between two existing branches. It never creates a branch.
          const raw = await c.post<Json>(
            `${enc(project)}/_apis/git/repositories/${enc(repo)}/pullrequests`,
            {
              sourceRefName: `refs/heads/${input.sourceBranch}`,
              targetRefName: `refs/heads/${input.targetBranch}`,
              title: input.title,
              ...(input.description ? { description: input.description } : {}),
              ...(input.isDraft ? { isDraft: true } : {}),
            }
          );
          return mapPullRequest(raw, c.base, project);
        });
      },

      async addComment(ctx, input: PullRequestCommentInput): Promise<PullRequestCommentResult> {
        const c = call(ctx, deps);
        const project = ctx.binding.project;
        return writing(ctx.account, async () => {
          const pr = await requireProjectPullRequest(c, project, input.id);
          const repoId = (pr.repository as Json).id as string;
          const url = mapPullRequest(pr, c.base, project).url;
          const prPath = `${enc(project)}/_apis/git/repositories/${enc(repoId)}/pullrequests/${input.id}`;
          if (input.threadId !== undefined) {
            const reply = await c.post<Json>(`${prPath}/threads/${input.threadId}/comments`, {
              content: input.text,
              parentCommentId: 1,
              commentType: 1,
            });
            return {
              pullRequestId: input.id,
              threadId: input.threadId,
              ...(typeof reply.id === "number" ? { commentId: reply.id } : {}),
              url,
            };
          }
          const line = input.line;
          const thread = await c.post<Json>(`${prPath}/threads`, {
            comments: [{ parentCommentId: 0, content: input.text, commentType: 1 }],
            status: 1,
            ...(input.filePath && line !== undefined
              ? {
                  threadContext: {
                    filePath: input.filePath,
                    rightFileStart: { line, offset: 1 },
                    rightFileEnd: { line, offset: 1 },
                  },
                }
              : {}),
          });
          return {
            pullRequestId: input.id,
            ...(typeof thread.id === "number" ? { threadId: thread.id } : {}),
            url,
          };
        });
      },
    },

    builds: {
      async list(ctx, q: BuildQuery): Promise<Page<BuildSummary>> {
        const c = call(ctx, deps);
        const project = ctx.binding.project;
        const branch = q.branch
          ? q.branch.startsWith("refs/")
            ? q.branch
            : `refs/heads/${q.branch}`
          : undefined;
        const raw = await c.get<Json>(`${enc(project)}/_apis/build/builds`, {
          $top: q.offset + q.limit + 1,
          queryOrder: "queueTimeDescending",
          statusFilter: q.status && q.status !== "all" ? q.status : undefined,
          resultFilter: q.result,
          branchName: branch,
        });
        const rows = list(raw).map((b) => mapBuild(b, c.base, project));
        return page(rows, q.limit, q.offset);
      },

      async log(ctx, id, q: BuildLogQuery): Promise<BuildLogResult> {
        const c = call(ctx, deps);
        const project = ctx.binding.project;
        const buildPath = `${enc(project)}/_apis/build/builds/${id}`;
        const build = mapBuild(await c.get<Json>(buildPath), c.base, project);

        const logsRaw = await c.get<Json>(`${buildPath}/logs`);
        const logs = list(logsRaw).map((l) => {
          const o = l as Json;
          return {
            id: Number(o.id),
            lineCount: typeof o.lineCount === "number" ? o.lineCount : undefined,
            type: typeof o.type === "string" ? o.type : undefined,
          };
        });

        if (q.logId === undefined) {
          let failures;
          try {
            failures = mapFailures(await c.get<Json>(`${buildPath}/timeline`));
          } catch {
            failures = undefined; // the timeline is a convenience; the log list is still returned
          }
          return { build, logs: logs.slice(0, 60), ...(failures ? { failures } : {}) };
        }

        const lineCount = logs.find((l) => l.id === q.logId)?.lineCount;
        let endLine = q.endLine ?? lineCount ?? DEFAULT_LOG_TAIL;
        let startLine = q.startLine ?? Math.max(1, endLine - DEFAULT_LOG_TAIL + 1);
        endLine = Math.max(startLine, endLine);
        if (endLine - startLine + 1 > MAX_LOG_LINES) startLine = endLine - MAX_LOG_LINES + 1;
        const text = await c.getText(`${buildPath}/logs/${q.logId}`, { startLine, endLine });
        return {
          build,
          log: {
            id: q.logId,
            startLine,
            endLine,
            ...(lineCount !== undefined ? { lineCount } : {}),
            text: clipText(text, MAX_LOG_CHARS) ?? "",
          },
        };
      },
    },
  };
}
