import { htmlField, htmlToText, clipText } from "../../format";
import {
  IntegrationError,
  type BuildFailure,
  type BuildSummary,
  type Comment,
  type PullRequestSummary,
  type PullRequestThread,
  type WorkItemDetail,
  type WorkItemRelation,
  type WorkItemSummary,
  type WorkItemQuery,
} from "../../types";

type Json = Record<string, unknown>;

const asObj = (v: unknown): Json => (typeof v === "object" && v !== null ? (v as Json) : {});
const asStr = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const asNum = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Identity fields arrive as `{displayName, uniqueName}` objects, or as plain strings on older servers. */
export function identityName(v: unknown): string | undefined {
  if (typeof v === "string") return v || undefined;
  const o = asObj(v);
  return asStr(o.displayName) ?? asStr(o.uniqueName);
}

const BODY_MAX = 4000;
const COMMENT_MAX = 800;

/** Escape a value for a WIQL string literal. */
export function wiqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Validate that a custom WIQL query does not bypass the active project boundary.
 * Rejects unscoped queries, queries targeting another project, negative conditions,
 * and top-level OR disjunctions that could leak other projects' items.
 */
export function assertWiqlProjectScope(wiql: string, boundProject: string): void {
  // Strip string literals to prevent field names inside literals (e.g. titles) from triggering matchers
  const withoutStrings = wiql.replace(/'(?:''|[^'])*'/g, "''");

  const projectField = /(?:\[?System\.TeamProject\]?|\bTeamProject\b)/i;
  if (!projectField.test(withoutStrings)) {
    throw new IntegrationError(
      "bad_request",
      `Custom wiql must be scoped to the bound project using [System.TeamProject] = @project or [System.TeamProject] = '${boundProject.replace(/'/g, "''")}'.`
    );
  }

  // Reject negative operators or clauses on TeamProject (<>, !=, NOT IN, NOT (...TeamProject...))
  if (
    /(?:\[?System\.TeamProject\]?|\bTeamProject\b)\s*(?:<>|!=|\bnot\s+in\b)/i.test(
      withoutStrings
    ) ||
    /\bNOT\s*\(*\s*(?:\[?System\.TeamProject\]?|\bTeamProject\b)/i.test(withoutStrings)
  ) {
    throw new IntegrationError("bad_request", "Custom wiql cannot negate the project boundary.");
  }

  // Reject top-level OR operations that could bypass project scope
  const whereMatch = /\bWHERE\b([\s\S]*?)(?:\bORDER\s+BY\b|$)/i.exec(withoutStrings);
  if (whereMatch) {
    const whereClause = whereMatch[1];
    let depth = 0;
    for (let i = 0; i < whereClause.length; i++) {
      const ch = whereClause[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      else if (depth === 0 && /\bOR\b/i.test(whereClause.slice(i, i + 3))) {
        throw new IntegrationError(
          "bad_request",
          "Custom wiql cannot use top-level OR clauses that could bypass the project boundary."
        );
      }
    }
  }

  // Extract all equality conditions on TeamProject
  const equalsPattern =
    /(?:\[?System\.TeamProject\]?|\bTeamProject\b)\s*=\s*(@project|'(?:''|[^'])*')/gi;
  const matches = Array.from(wiql.matchAll(equalsPattern));
  if (matches.length === 0) {
    throw new IntegrationError(
      "bad_request",
      `Custom wiql must equate [System.TeamProject] to @project or '${boundProject.replace(/'/g, "''")}'.`
    );
  }

  const normalizedBound = boundProject.trim().toLowerCase();
  for (const match of matches) {
    const target = match[1].trim();
    if (target.toLowerCase() === "@project") continue;
    const unquoted = target.slice(1, -1).replace(/''/g, "'").trim().toLowerCase();
    if (unquoted !== normalizedBound) {
      throw new IntegrationError(
        "bad_request",
        `Custom wiql targets project "${target.slice(1, -1)}", but this repository is bound to "${boundProject}".`
      );
    }
  }
}

/** The structured filters as a WIQL query scoped to the project in the URL (`@project`). */
export function buildWiql(
  q: Pick<WorkItemQuery, "text" | "state" | "type" | "assignedTo">
): string {
  const where = ["[System.TeamProject] = @project"];
  if (q.text) where.push(`[System.Title] CONTAINS ${wiqlString(q.text)}`);
  if (q.state) where.push(`[System.State] = ${wiqlString(q.state)}`);
  if (q.type) where.push(`[System.WorkItemType] = ${wiqlString(q.type)}`);
  if (q.assignedTo) {
    where.push(
      q.assignedTo.toLowerCase() === "me"
        ? "[System.AssignedTo] = @Me"
        : `[System.AssignedTo] = ${wiqlString(q.assignedTo)}`
    );
  }
  return `SELECT [System.Id] FROM WorkItems WHERE ${where.join(" AND ")} ORDER BY [System.ChangedDate] DESC`;
}

export function workItemUrl(baseUrl: string, project: string, id: number): string {
  return `${baseUrl}/${encodeURIComponent(project)}/_workitems/edit/${id}`;
}

export function mapWorkItemSummary(
  raw: unknown,
  baseUrl: string,
  project: string
): WorkItemSummary {
  const o = asObj(raw);
  const f = asObj(o.fields);
  const id = asNum(o.id) ?? 0;
  return {
    id,
    type: asStr(f["System.WorkItemType"]) ?? "Unknown",
    title: clipText(asStr(f["System.Title"]) ?? "", 300) ?? "",
    state: asStr(f["System.State"]) ?? "Unknown",
    assignedTo: identityName(f["System.AssignedTo"]),
    changedAt: asStr(f["System.ChangedDate"]),
    url: workItemUrl(baseUrl, project, id),
  };
}

const RELATION_KINDS: Record<string, string> = {
  "System.LinkTypes.Hierarchy-Forward": "child",
  "System.LinkTypes.Hierarchy-Reverse": "parent",
  "System.LinkTypes.Related": "related",
  "System.LinkTypes.Dependency-Forward": "successor",
  "System.LinkTypes.Dependency-Reverse": "predecessor",
  AttachedFile: "attachment",
  Hyperlink: "link",
};

/** `vstfs:///Git/PullRequestId/<project>%2F<repo>%2F<id>` carries the PR id last. */
function artifactId(url: string): number | undefined {
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    // keep the raw url; the id is simply not found
  }
  const n = Number(decoded.split("/").pop());
  return Number.isInteger(n) ? n : undefined;
}

export function mapRelations(raw: unknown): WorkItemRelation[] {
  const out: WorkItemRelation[] = [];
  for (const item of asArr(raw)) {
    const r = asObj(item);
    const rel = asStr(r.rel) ?? "";
    const url = asStr(r.url);
    const attrName = asStr(asObj(r.attributes).name);
    if (rel === "ArtifactLink" && url) {
      const kind = /PullRequestId/i.test(url)
        ? "pull-request"
        : /Git\/Commit/i.test(url)
          ? "commit"
          : /Git\/Ref/i.test(url)
            ? "branch"
            : (attrName ?? "artifact").toLowerCase();
      out.push({ kind, ...(kind === "pull-request" ? { id: artifactId(url) } : {}) });
      continue;
    }
    const kind = RELATION_KINDS[rel] ?? (attrName ?? rel).toLowerCase();
    const idMatch = url ? /\/workItems\/(\d+)$/i.exec(url) : null;
    out.push({
      kind: kind || "link",
      ...(idMatch ? { id: Number(idMatch[1]) } : {}),
      ...(!idMatch && url && rel !== "AttachedFile" ? { url } : {}),
      ...(rel === "AttachedFile" && attrName ? { title: attrName } : {}),
    });
  }
  return out.slice(0, 50);
}

export function mapComments(raw: unknown): Comment[] {
  return asArr(asObj(raw).comments)
    .map((c): Comment => {
      const o = asObj(c);
      return {
        author: identityName(o.createdBy),
        at: asStr(o.createdDate),
        text: htmlField(asStr(o.text), COMMENT_MAX) ?? "",
      };
    })
    .filter((c) => c.text);
}

export function mapWorkItemDetail(
  raw: unknown,
  baseUrl: string,
  project: string
): Omit<WorkItemDetail, "comments"> {
  const o = asObj(raw);
  const f = asObj(o.fields);
  const tags = (asStr(f["System.Tags"]) ?? "")
    .split(";")
    .map((t) => t.trim())
    .filter(Boolean);
  return {
    ...mapWorkItemSummary(raw, baseUrl, project),
    description: htmlField(asStr(f["System.Description"]), BODY_MAX),
    acceptanceCriteria: htmlField(asStr(f["Microsoft.VSTS.Common.AcceptanceCriteria"]), BODY_MAX),
    reproSteps: htmlField(asStr(f["Microsoft.VSTS.TCM.ReproSteps"]), BODY_MAX),
    tags,
    priority: asNum(f["Microsoft.VSTS.Common.Priority"]),
    areaPath: asStr(f["System.AreaPath"]),
    iterationPath: asStr(f["System.IterationPath"]),
    createdBy: identityName(f["System.CreatedBy"]),
    createdAt: asStr(f["System.CreatedDate"]),
    relations: mapRelations(o.relations),
  };
}

export function branchName(ref: unknown): string {
  return (asStr(ref) ?? "").replace(/^refs\/heads\//, "");
}

export function mapPullRequest(raw: unknown, baseUrl: string, project: string): PullRequestSummary {
  const o = asObj(raw);
  const repo = asObj(o.repository);
  const id = asNum(o.pullRequestId) ?? 0;
  const repoName = asStr(repo.name);
  return {
    id,
    title: clipText(asStr(o.title) ?? "", 300) ?? "",
    status: asStr(o.status) ?? "unknown",
    isDraft: o.isDraft === true,
    author: identityName(o.createdBy),
    repo: repoName,
    sourceBranch: branchName(o.sourceRefName),
    targetBranch: branchName(o.targetRefName),
    createdAt: asStr(o.creationDate),
    url: repoName
      ? `${baseUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repoName)}/pullrequest/${id}`
      : `${baseUrl}/${encodeURIComponent(project)}/_git`,
  };
}

const VOTES: Record<number, string> = {
  10: "approved",
  5: "approved with suggestions",
  0: "no vote",
  [-5]: "waiting for author",
  [-10]: "rejected",
};

export function mapReviewers(
  raw: unknown
): Array<{ name: string; vote: string; required: boolean }> {
  return asArr(raw).map((r) => {
    const o = asObj(r);
    return {
      name: identityName(o) ?? "unknown",
      vote: VOTES[asNum(o.vote) ?? 0] ?? "no vote",
      required: o.isRequired === true,
    };
  });
}

export const MAX_THREADS = 30;
const MAX_THREAD_COMMENTS = 5;

/** Human review threads only: system events and deleted threads are noise for an agent. */
export function mapThreads(raw: unknown): { threads: PullRequestThread[]; total: number } {
  const kept: PullRequestThread[] = [];
  for (const t of asArr(asObj(raw).value)) {
    const o = asObj(t);
    if (o.isDeleted === true) continue;
    const comments = asArr(o.comments)
      .map(asObj)
      .filter((c) => c.isDeleted !== true && asStr(c.commentType) !== "system")
      .map((c): Comment => ({
        author: identityName(c.author),
        at: asStr(c.publishedDate),
        text: clipText(htmlToText(asStr(c.content)), COMMENT_MAX) ?? "",
      }))
      .filter((c) => c.text);
    if (comments.length === 0) continue;
    const ctx = asObj(o.threadContext);
    const start = asObj(ctx.rightFileStart ?? ctx.leftFileStart);
    kept.push({
      id: asNum(o.id) ?? 0,
      status: asStr(o.status),
      filePath: asStr(ctx.filePath),
      line: asNum(start.line),
      comments: comments.slice(0, MAX_THREAD_COMMENTS),
    });
  }
  return { threads: kept.slice(0, MAX_THREADS), total: kept.length };
}

export function mapBuild(raw: unknown, baseUrl: string, project: string): BuildSummary {
  const o = asObj(raw);
  const id = asNum(o.id) ?? 0;
  const web = asStr(asObj(asObj(o._links).web).href);
  return {
    id,
    number: asStr(o.buildNumber) ?? String(id),
    definition: asStr(asObj(o.definition).name),
    status: asStr(o.status) ?? "unknown",
    result: asStr(o.result),
    branch: branchName(o.sourceBranch) || undefined,
    commit: asStr(o.sourceVersion)?.slice(0, 12),
    requestedBy: identityName(o.requestedFor),
    startedAt: asStr(o.startTime),
    finishedAt: asStr(o.finishTime),
    url: web ?? `${baseUrl}/${encodeURIComponent(project)}/_build/results?buildId=${id}`,
  };
}

/** Failed steps and their error messages from a build timeline. */
export function mapFailures(raw: unknown): BuildFailure[] {
  const out: BuildFailure[] = [];
  for (const r of asArr(asObj(raw).records)) {
    const o = asObj(r);
    if (asStr(o.result) !== "failed") continue;
    const issues = asArr(o.issues)
      .map(asObj)
      .filter((i) => asStr(i.type) === "error")
      .map((i) => clipText(asStr(i.message) ?? "", 400) ?? "")
      .filter(Boolean);
    const type = asStr(o.type);
    // Stages and jobs repeat their children's failures; keep leaf steps with a log.
    if (type !== "Task" && issues.length === 0) continue;
    out.push({
      step: asStr(o.name) ?? "unknown step",
      logId: asNum(asObj(o.log).id),
      issues: issues.slice(0, 5),
    });
  }
  return out.slice(0, 10);
}
