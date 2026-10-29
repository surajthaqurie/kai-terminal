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
} from "./types";
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
}

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
];

const TOOL_NAMES = new Set(TOOL_DEFS.map((t) => t.name));

export function isIntegrationTool(name: string): boolean {
  return TOOL_NAMES.has(name);
}

/** Tool definitions for the project's active provider; empty when nothing is bound. */
export function integrationToolDefs(projectDir: string): Array<Omit<ToolDef, "capability">> {
  let provider: IntegrationProvider | null = null;
  try {
    const found = findBinding(projectDir);
    provider = found ? getProvider(found.binding.provider) : null;
  } catch {
    return []; // an unreadable binding must never break the code-map tools
  }
  if (!provider) return [];
  const caps = capabilitiesOf(provider);
  return TOOL_DEFS.filter((t) => t.capability === "status" || caps.has(t.capability)).map(
    ({ capability: _capability, ...def }) => def
  );
}

const failArgs = (message: string): ToolOutcome => ({ kind: "error", code: -32602, message });

function text(v: unknown, max = 200): string | undefined {
  return typeof v === "string" && v.trim() ? clipChars(v.trim(), max) : undefined;
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
        },
      };
    }

    const unsupported = (): ToolOutcome => ({
      kind: "error",
      code: -32601,
      message: `${label} does not support ${name}.`,
    });

    switch (name) {
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
