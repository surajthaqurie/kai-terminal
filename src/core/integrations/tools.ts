import { findBinding } from "./config";
import { UNTRUSTED_NOTICE } from "./format";
import { findProvider } from "./providerCatalog";
import { getProvider } from "./providers";
import { resolveReady, type ServiceDeps } from "./service";
import {
  asIntegrationError,
  capabilitiesOf,
  type Capability,
  type IntegrationProvider,
  type Page,
  type ProviderContext,
} from "./types";
import { effectiveRules, isValidBranchName, normalizeBranch } from "./workflowRules";
import type { ToolOutcome } from "../mcpTools";
import { clipChars, parsePageArgs, type Shrinkable } from "../mcpResponse";

/**
 * Provider-neutral MCP tools. The agent sees the same names whichever
 * integration a project uses; only the active provider's supported tools are
 * listed. With no integration bound, `integrationToolDefs` is empty and the
 * server's tool list is exactly what it was before integrations existed.
 * Descriptions stay short: agents carry them in context on every turn.
 */
interface ToolDef {
  name: string;
  description: string;
  capability: Capability | "status";
  inputSchema: Record<string, unknown>;
  /**
   * Changes data in the remote service. Listed and runnable only for a project whose
   * user turned write tools on, and only when the provider implements it.
   */
  write?: true;
}

/** Longest comment a write tool accepts. Over it is refused, never silently cut. */
const WRITE_TEXT_MAX = 8000;
const PR_TITLE_MAX = 400;
const PR_DESCRIPTION_MAX = 4000;
const STATE_MAX = 60;
const FILE_PATH_MAX = 400;

const PAGE_PROPS = {
  limit: { type: "number", description: "Page size (default 20, max 50)." },
  offset: { type: "number", description: "Items to skip (use nextOffset)." },
};

const TOOL_DEFS: ToolDef[] = [
  {
    name: "kai_integration_status",
    description: "Which external service this project is connected to, and which tools it offers.",
    capability: "status",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "kai_workflow_rules",
    description:
      "The branch to start new work from and open pull requests into, and the regular expression new branch names should match when one is set. Call before creating a branch. Guidance, not enforced.",
    capability: "status",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "kai_work_item_search",
    description:
      "Search work items (newest changed first). Filters are ANDed; `wiql` (SELECT only) overrides them.",
    capability: "work-items",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Words in the title." },
        state: { type: "string", description: "e.g. Active, Closed." },
        type: { type: "string", description: "e.g. Bug, Task, User Story." },
        assignedTo: { type: "string", description: '"me", a name, or an email.' },
        wiql: { type: "string", description: "Raw read-only WIQL query." },
        ...PAGE_PROPS,
      },
    },
  },
  {
    name: "kai_work_item_get",
    description: "One work item: description, acceptance criteria, relations, recent comments.",
    capability: "work-items",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number", description: "Work item id." } },
      required: ["id"],
    },
  },
  {
    name: "kai_pr_list",
    description: "Pull requests, newest first (default: active).",
    capability: "pull-requests",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "completed", "abandoned", "all"] },
        repo: { type: "string", description: "Repository (default: the project's)." },
        ...PAGE_PROPS,
      },
    },
  },
  {
    name: "kai_pr_get",
    description: "One pull request: reviewers, changed files, review threads.",
    capability: "pull-requests",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number", description: "Pull request id." } },
      required: ["id"],
    },
  },
  {
    name: "kai_build_list",
    description: "Recent builds, newest first.",
    capability: "builds",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["inProgress", "completed", "notStarted", "all"] },
        result: { type: "string", enum: ["succeeded", "failed", "canceled", "partiallySucceeded"] },
        branch: { type: "string", description: "Branch name or full ref." },
        ...PAGE_PROPS,
      },
    },
  },
  {
    name: "kai_build_log",
    description:
      "A build's failed steps and log list; pass logId for log text (last 150 lines by default, max 400).",
    capability: "builds",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Build id." },
        logId: { type: "number", description: "Log to read." },
        startLine: { type: "number" },
        endLine: { type: "number" },
      },
      required: ["id"],
    },
  },
  // ---- Write tools: off unless the user ran `kai integration azure --allow-writes` ----
  {
    name: "kai_work_item_comment",
    description:
      "WRITES to the remote service: adds a comment to a work item in this project. Only post what the user asked for.",
    capability: "work-items",
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Work item id." },
        text: { type: "string", description: `Plain text, up to ${WRITE_TEXT_MAX} characters.` },
      },
      required: ["id", "text"],
    },
  },
  {
    name: "kai_work_item_set_state",
    description:
      "WRITES to the remote service: changes a work item's state (e.g. Active, Resolved). Only when the user asked.",
    capability: "work-items",
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Work item id." },
        state: { type: "string", description: "The new state, exactly as the project spells it." },
      },
      required: ["id", "state"],
    },
  },
  {
    name: "kai_pr_create",
    description:
      "WRITES to the remote service: opens a pull request between two branches that already exist and are pushed. Never creates a branch. targetBranch defaults to the project's merge branch.",
    capability: "pull-requests",
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        sourceBranch: { type: "string", description: "Branch with the changes." },
        targetBranch: {
          type: "string",
          description: "Branch to merge into (default: merge branch).",
        },
        title: { type: "string", description: `Up to ${PR_TITLE_MAX} characters.` },
        description: { type: "string", description: `Up to ${PR_DESCRIPTION_MAX} characters.` },
        isDraft: { type: "boolean", description: "Open as a draft." },
      },
      required: ["sourceBranch", "title"],
    },
  },
  {
    name: "kai_pr_comment",
    description:
      "WRITES to the remote service: comments on a pull request in this project, as a new thread (optionally on a file line) or a reply to threadId.",
    capability: "pull-requests",
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Pull request id." },
        text: { type: "string", description: `Markdown, up to ${WRITE_TEXT_MAX} characters.` },
        threadId: { type: "number", description: "Reply to this thread." },
        filePath: { type: "string", description: "New thread on this file (needs line)." },
        line: { type: "number", description: "Line of filePath (needs filePath)." },
      },
      required: ["id", "text"],
    },
  },
];

const TOOL_NAMES = new Set(TOOL_DEFS.map((t) => t.name));
const WRITE_TOOL_NAMES = new Set(TOOL_DEFS.filter((t) => t.write).map((t) => t.name));

/** True for a tool that changes data in the remote service. */
export function isWriteTool(name: string): boolean {
  return WRITE_TOOL_NAMES.has(name);
}

/** Whether `provider` implements the method behind a write tool. */
function providerCanWrite(provider: IntegrationProvider, name: string): boolean {
  switch (name) {
    case "kai_work_item_comment":
      return Boolean(provider.workItems?.addComment);
    case "kai_work_item_set_state":
      return Boolean(provider.workItems?.setState);
    case "kai_pr_create":
      return Boolean(provider.pullRequests?.create);
    case "kai_pr_comment":
      return Boolean(provider.pullRequests?.addComment);
    default:
      return false;
  }
}

export function isIntegrationTool(name: string): boolean {
  return TOOL_NAMES.has(name);
}

/** Tool definitions for the project's active provider; empty when nothing is bound. */
export function integrationToolDefs(projectDir: string): Array<Omit<ToolDef, "capability">> {
  let provider: IntegrationProvider | null = null;
  let writesAllowed = false;
  try {
    const found = findBinding(projectDir);
    provider = found ? getProvider(found.binding.provider) : null;
    writesAllowed = found?.binding.writeTools === true;
  } catch {
    return []; // an unreadable binding must never break the code-map tools
  }
  if (!provider) return [];
  const caps = capabilitiesOf(provider);
  const bound = provider;
  return TOOL_DEFS.filter((t) => {
    if (t.write) return writesAllowed && providerCanWrite(bound, t.name);
    return t.capability === "status" || caps.has(t.capability);
  }).map(({ capability: _capability, write: _write, ...def }) => def);
}

const failArgs = (message: string): ToolOutcome => ({ kind: "error", code: -32602, message });

function text(v: unknown, max = 200): string | undefined {
  return typeof v === "string" && v.trim() ? clipChars(v.trim(), max) : undefined;
}

/**
 * Free text for a write: required, trimmed, and REFUSED (not cut) when over `max` or when it
 * carries control characters other than tab and line breaks. Null when not acceptable.
 */
function writeText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t.length > max) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(t)) return null;
  return t;
}

/** A branch name for a write: the same conservative check as the workflow rules, `refs/heads/` tolerated. */
function writeBranch(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const name = normalizeBranch(v);
  return isValidBranchName(name) ? name : null;
}

function positiveInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined | null {
  if (v === undefined) return undefined;
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

const PAGE = { defaultLimit: 20, maxLimit: 50 };

function pagePayload<T>(p: Page<T>, offset: number): Record<string, unknown> {
  return {
    items: p.items,
    returned: p.items.length,
    offset,
    hasMore: p.hasMore,
    ...(p.hasMore && p.nextOffset !== undefined ? { nextOffset: p.nextOffset } : {}),
    notice: UNTRUSTED_NOTICE,
  };
}

function listShrink(offset: number): Shrinkable[] {
  return [
    {
      key: "items",
      patch: (kept, payload) => {
        payload.returned = kept;
        payload.hasMore = true;
        payload.nextOffset = offset + kept;
      },
    },
  ];
}

const DETAIL_SHRINK: Shrinkable[] = [
  { key: "comments" },
  { key: "threads" },
  { key: "changedFiles" },
  { key: "relations" },
];

/** The repository's default branch, or null when it is not bound to one or the lookup fails. */
async function repoDefaultBranch(
  provider: IntegrationProvider,
  ctx: ProviderContext
): Promise<string | null> {
  const repo = ctx.binding.repo;
  if (!repo || !provider.discovery) return null;
  try {
    const repos = await provider.discovery.listRepos(ctx.account, ctx.secrets, ctx.binding.project);
    return repos.find((r) => r.name.toLowerCase() === repo.toLowerCase())?.defaultBranch ?? null;
  } catch {
    return null; // the rules are still useful without the default branch
  }
}

/** Run one neutral tool against the project's active integration. */
export async function runIntegrationTool(
  name: string,
  args: Record<string, unknown>,
  projectDir: string,
  deps: ServiceDeps = {}
): Promise<ToolOutcome> {
  try {
    const { provider, ctx } = await resolveReady(projectDir, deps);
    const label = provider.info.label;

    if (name === "kai_integration_status") {
      return {
        kind: "json",
        payload: {
          provider: provider.info.id,
          label,
          account: ctx.account.id,
          ...(ctx.account.user ? { signedInAs: ctx.account.user } : {}),
          project: ctx.binding.project,
          repo: ctx.binding.repo,
          capabilities: [...capabilitiesOf(provider)],
          // Whether the user let agents change data here; the write tools exist only when true.
          writeTools: ctx.binding.writeTools === true,
        },
      };
    }

    const unsupported = (): ToolOutcome => ({
      kind: "error",
      code: -32601,
      message: `${label} does not support ${name}.`,
    });

    // Writes are re-checked on every call, from the binding as it is on disk right now, so a
    // tool list an agent cached before the user turned write tools off cannot still write.
    if (isWriteTool(name)) {
      if (ctx.binding.writeTools !== true) {
        return {
          kind: "error",
          code: -32000,
          message: `${name} changes data in ${label} and write tools are off for this project. Only the user can turn them on (\`kai integration azure --allow-writes\`); ask them if the change is wanted.`,
        };
      }
      if (!providerCanWrite(provider, name)) return unsupported();
    }

    switch (name) {
      case "kai_workflow_rules": {
        const { mergeBranch, branchPattern } = effectiveRules(ctx.binding.rules);
        // A naming pattern is only included when one is set.
        const naming = branchPattern
          ? {
              branchPattern,
              branchPatternNote: `Name new branches so the whole name matches this regular expression: ${branchPattern}`,
            }
          : {};
        if (mergeBranch) {
          return {
            kind: "json",
            payload: {
              baseBranch: mergeBranch,
              ...naming,
              note: `Create new branches from origin/${mergeBranch} and open pull requests into ${mergeBranch}.`,
            },
          };
        }
        // No merge branch is configured: the repository's own default is the base.
        const baseBranch = await repoDefaultBranch(provider, ctx);
        return {
          kind: "json",
          payload: {
            baseBranch,
            ...naming,
            note: "No merge branch is configured: use the repository's default branch.",
          },
        };
      }
      case "kai_work_item_search": {
        if (!provider.workItems) return unsupported();
        const page = parsePageArgs(args, PAGE);
        if (!page.ok) return failArgs(page.message);
        const result = await provider.workItems.search(ctx, {
          text: text(args.text),
          state: text(args.state, 60),
          type: text(args.type, 60),
          assignedTo: text(args.assignedTo, 120),
          wiql: typeof args.wiql === "string" ? args.wiql : undefined,
          limit: page.limit,
          offset: page.offset,
        });
        return {
          kind: "json",
          payload: pagePayload(result, page.offset),
          shrink: listShrink(page.offset),
          metrics: { resultCount: result.items.length, hasMore: result.hasMore },
        };
      }
      case "kai_work_item_get": {
        if (!provider.workItems) return unsupported();
        const id = positiveInt(args.id);
        if (id === null) return failArgs("id must be a positive integer");
        const detail = await provider.workItems.get(ctx, id);
        return {
          kind: "json",
          payload: { ...detail, notice: UNTRUSTED_NOTICE },
          shrink: DETAIL_SHRINK,
        };
      }
      case "kai_pr_list": {
        if (!provider.pullRequests) return unsupported();
        const page = parsePageArgs(args, PAGE);
        if (!page.ok) return failArgs(page.message);
        const status = oneOf(args.status, ["active", "completed", "abandoned", "all"] as const);
        if (status === null) return failArgs("status must be active, completed, abandoned or all");
        const result = await provider.pullRequests.list(ctx, {
          status,
          repo: text(args.repo, 120),
          limit: page.limit,
          offset: page.offset,
        });
        return {
          kind: "json",
          payload: pagePayload(result, page.offset),
          shrink: listShrink(page.offset),
          metrics: { resultCount: result.items.length, hasMore: result.hasMore },
        };
      }
      case "kai_pr_get": {
        if (!provider.pullRequests) return unsupported();
        const id = positiveInt(args.id);
        if (id === null) return failArgs("id must be a positive integer");
        const detail = await provider.pullRequests.get(ctx, id);
        return {
          kind: "json",
          payload: { ...detail, notice: UNTRUSTED_NOTICE },
          shrink: DETAIL_SHRINK,
        };
      }
      case "kai_work_item_comment": {
        const id = positiveInt(args.id);
        if (id === null) return failArgs("id must be a positive integer");
        const body = writeText(args.text, WRITE_TEXT_MAX);
        if (body === null) {
          return failArgs(`text is required, at most ${WRITE_TEXT_MAX} characters, and plain text`);
        }
        const done = await provider.workItems!.addComment!(ctx, id, body);
        return { kind: "json", payload: { ok: true, changed: "work item comment added", ...done } };
      }
      case "kai_work_item_set_state": {
        const id = positiveInt(args.id);
        if (id === null) return failArgs("id must be a positive integer");
        const state = writeText(args.state, STATE_MAX);
        if (state === null || /[\r\n\t]/.test(state)) {
          return failArgs(`state is required, one line, at most ${STATE_MAX} characters`);
        }
        const done = await provider.workItems!.setState!(ctx, id, state);
        return { kind: "json", payload: { ok: true, changed: "work item state changed", ...done } };
      }
      case "kai_pr_create": {
        const source = writeBranch(args.sourceBranch);
        if (source === null) return failArgs("sourceBranch must be a valid branch name");
        let target: string | null;
        if (args.targetBranch === undefined) {
          const configured = effectiveRules(ctx.binding.rules).mergeBranch;
          const fallback = configured || (await repoDefaultBranch(provider, ctx)) || "";
          target = fallback ? fallback : null;
          if (target === null) {
            return failArgs(
              "targetBranch is required: this project has no merge branch or default branch"
            );
          }
        } else {
          target = writeBranch(args.targetBranch);
          if (target === null) return failArgs("targetBranch must be a valid branch name");
        }
        if (source === target) return failArgs("sourceBranch and targetBranch must differ");
        const title = writeText(args.title, PR_TITLE_MAX);
        if (title === null || /[\r\n]/.test(title)) {
          return failArgs(`title is required, one line, at most ${PR_TITLE_MAX} characters`);
        }
        let description: string | undefined;
        if (args.description !== undefined) {
          const d = writeText(args.description, PR_DESCRIPTION_MAX);
          if (d === null)
            return failArgs(`description must be at most ${PR_DESCRIPTION_MAX} characters`);
          description = d;
        }
        if (args.isDraft !== undefined && typeof args.isDraft !== "boolean") {
          return failArgs("isDraft must be true or false");
        }
        const created = await provider.pullRequests!.create!(ctx, {
          sourceBranch: source,
          targetBranch: target,
          title,
          description,
          isDraft: args.isDraft === true,
        });
        return {
          kind: "json",
          payload: { ok: true, changed: "pull request created", pullRequest: created },
        };
      }
      case "kai_pr_comment": {
        const id = positiveInt(args.id);
        if (id === null) return failArgs("id must be a positive integer");
        const body = writeText(args.text, WRITE_TEXT_MAX);
        if (body === null) {
          return failArgs(`text is required, at most ${WRITE_TEXT_MAX} characters`);
        }
        const threadId = args.threadId === undefined ? undefined : positiveInt(args.threadId);
        if (threadId === null) return failArgs("threadId must be a positive integer");
        const line = args.line === undefined ? undefined : positiveInt(args.line);
        if (line === null) return failArgs("line must be a positive integer");
        let filePath: string | undefined;
        if (args.filePath !== undefined) {
          const f = writeText(args.filePath, FILE_PATH_MAX);
          if (f === null || /[\r\n]/.test(f) || f.split(/[\\/]/).includes("..")) {
            return failArgs("filePath must be a repository path of at most 400 characters");
          }
          filePath = `/${f.replace(/\\/g, "/").replace(/^\/+/, "")}`;
        }
        if ((filePath === undefined) !== (line === undefined)) {
          return failArgs("filePath and line go together: give both or neither");
        }
        if (threadId !== undefined && filePath !== undefined) {
          return failArgs("a reply (threadId) cannot also start a file thread (filePath, line)");
        }
        const done = await provider.pullRequests!.addComment!(ctx, {
          id,
          text: body,
          threadId,
          filePath,
          line,
        });
        return {
          kind: "json",
          payload: { ok: true, changed: "pull request comment added", ...done },
        };
      }
      case "kai_build_list": {
        if (!provider.builds) return unsupported();
        const page = parsePageArgs(args, PAGE);
        if (!page.ok) return failArgs(page.message);
        const status = oneOf(args.status, [
          "inProgress",
          "completed",
          "notStarted",
          "all",
        ] as const);
        const result = oneOf(args.result, [
          "succeeded",
          "failed",
          "canceled",
          "partiallySucceeded",
        ] as const);
        if (status === null || result === null) return failArgs("invalid status or result filter");
        const builds = await provider.builds.list(ctx, {
          status,
          result,
          branch: text(args.branch, 200),
          limit: page.limit,
          offset: page.offset,
        });
        return {
          kind: "json",
          payload: pagePayload(builds, page.offset),
          shrink: listShrink(page.offset),
          metrics: { resultCount: builds.items.length, hasMore: builds.hasMore },
        };
      }
      case "kai_build_log": {
        if (!provider.builds) return unsupported();
        const id = positiveInt(args.id);
        if (id === null) return failArgs("id must be a positive integer");
        const logId = args.logId === undefined ? undefined : positiveInt(args.logId);
        if (logId === null) return failArgs("logId must be a positive integer");
        const startLine = args.startLine === undefined ? undefined : positiveInt(args.startLine);
        const endLine = args.endLine === undefined ? undefined : positiveInt(args.endLine);
        if (startLine === null || endLine === null) {
          return failArgs("startLine and endLine must be positive integers");
        }
        const result = await provider.builds.log(ctx, id, { logId, startLine, endLine });
        return {
          kind: "json",
          payload: { ...result, notice: UNTRUSTED_NOTICE },
          shrink: [{ key: "failures" }, { key: "logs" }],
        };
      }
      default:
        return { kind: "error", code: -32601, message: `Unknown tool: ${name}` };
    }
  } catch (err) {
    const e = asIntegrationError(err);
    return {
      kind: "error",
      code: -32000,
      message: [e.message, e.hint].filter(Boolean).join(" "),
    };
  }
}

/** Human label for a provider id, for messages. */
export function providerLabel(id: string): string {
  return findProvider(id)?.label ?? id;
}
