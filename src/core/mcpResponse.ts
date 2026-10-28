import type { McpResponse } from "./mcp";

/**
 * Shared final response shaping for MCP tool results.
 *
 * Every tool result is bounded in UTF-8 bytes of the whole JSON-RPC line (the
 * envelope, the tool-result wrapper and the second round of string escaping
 * that embedding JSON in `content[0].text` causes are all counted). Tools hand
 * over a structured payload plus the collections that may be shortened; the
 * shaper then picks how many items fit in one pass (no truncate-and-serialize
 * loop) and records what was left out. Required fields are never dropped.
 */

export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
export const MIN_MAX_RESPONSE_BYTES = 8 * 1024;
export const MAX_MAX_RESPONSE_BYTES = 1024 * 1024;

/** Longest JSON-RPC id echoed back; longer ids are rejected so the envelope stays bounded. */
export const MAX_ID_BYTES = 256;

/** Bytes kept free for truncation metadata and the digits of patched page fields. */
const METADATA_RESERVE_BYTES = 600;

export function getMaxResponseBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.KAI_MCP_MAX_RESPONSE_BYTES;
  if (raw === undefined || raw === "") return DEFAULT_MAX_RESPONSE_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_RESPONSE_BYTES;
  return Math.min(Math.max(Math.floor(parsed), MIN_MAX_RESPONSE_BYTES), MAX_MAX_RESPONSE_BYTES);
}

export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** UTF-8 bytes of `s` as it appears inside a JSON string literal (quotes excluded). */
export function jsonEscapedBytes(s: string): number {
  return utf8Bytes(JSON.stringify(s)) - 2;
}

/** Escaped size of a single UTF-16 code unit inside a JSON string (surrogates handled by the caller). */
function escapedUnitBytes(code: number): number {
  if (code === 0x22 || code === 0x5c) return 2;
  if (code < 0x20) {
    return code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d
      ? 2
      : 6;
  }
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  return 3;
}

/** Clip to at most `maxChars` UTF-16 units without splitting a surrogate pair. */
export function clipChars(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  let end = Math.max(0, maxChars);
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return s.slice(0, end);
}

/** Clip so that the string, once JSON-escaped, takes at most `maxBytes` bytes. One pass. */
export function clipEscapedBytes(s: string, maxBytes: number): string {
  let used = 0;
  let i = 0;
  while (i < s.length) {
    const code = s.charCodeAt(i);
    let units = 1;
    let bytes: number;
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        units = 2;
        bytes = 4;
      } else {
        bytes = 6; // lone surrogate is escaped as \udXXX
      }
    } else if (code >= 0xd800 && code <= 0xdfff) {
      bytes = 6;
    } else {
      bytes = escapedUnitBytes(code);
    }
    if (used + bytes > maxBytes) break;
    used += bytes;
    i += units;
  }
  return s.slice(0, i);
}

/** Echo-safe string for error messages and metadata: bounded in characters. */
export function clipForMessage(value: unknown, maxChars = 200): string {
  const s = typeof value === "string" ? value : String(value);
  return clipChars(s, maxChars);
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface PageWindow {
  limit: number;
  offset: number;
}

export type PageArgsResult = ({ ok: true } & PageWindow) | { ok: false; message: string };

export function parsePageArgs(
  args: Record<string, unknown>,
  opts: { defaultLimit: number; maxLimit: number }
): PageArgsResult {
  let limit = opts.defaultLimit;
  if (args.limit !== undefined) {
    if (typeof args.limit !== "number" || !Number.isFinite(args.limit) || args.limit <= 0) {
      return { ok: false, message: "limit parameter must be a positive number" };
    }
    limit = Math.min(Math.max(1, Math.floor(args.limit)), opts.maxLimit);
  }
  let offset = 0;
  if (args.offset !== undefined) {
    if (typeof args.offset !== "number" || !Number.isFinite(args.offset) || args.offset < 0) {
      return { ok: false, message: "offset parameter must be a non-negative number" };
    }
    offset = Math.floor(args.offset);
  }
  return { ok: true, limit, offset };
}

export interface PageFields {
  total: number;
  returned: number;
  offset: number;
  hasMore: boolean;
  nextOffset?: number;
}

/** Standard pagination fields for a window of `returned` items starting at `offset`. */
export function pageFields(total: number, offset: number, returned: number): PageFields {
  const end = offset + returned;
  const hasMore = end < total;
  return {
    total,
    returned,
    offset,
    hasMore,
    ...(hasMore ? { nextOffset: end } : {}),
  };
}

export function sliceWindow<T>(items: readonly T[], page: PageWindow): T[] {
  return items.slice(page.offset, page.offset + page.limit);
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

export interface Shrinkable<T = unknown> {
  /** Payload property holding the array. Earlier entries have priority for the byte budget. */
  key: string;
  /** Cheaper stand-in used when the full item no longer fits (e.g. drops source text). */
  lighten?: (item: T) => T;
  /** Called when fewer than all items were kept, to correct page fields such as `returned`/`hasMore`. */
  patch?: (kept: number, payload: Record<string, unknown>) => void;
}

export interface ShapedResult {
  response: McpResponse;
  /** UTF-8 bytes of the full JSON-RPC line. */
  bytes: number;
  truncated: boolean;
  dropped: Record<string, number>;
}

/** Bytes of the JSON-RPC + tool-result wrapper around a text payload (id echoed), for budgeting. */
export function wrapperBytes(id: string | number | null): number {
  return utf8Bytes(
    JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "" }] } })
  );
}

function textResponse(id: string | number | null, text: string): McpResponse {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
}

export function wireBytes(response: McpResponse): number {
  return utf8Bytes(JSON.stringify(response));
}

function overflowResponse(
  id: string | number | null,
  tool: string,
  maxBytes: number,
  originalBytes: number
): ShapedResult {
  const text = JSON.stringify({
    error: "response_too_large",
    tool,
    truncated: true,
    maxBytes,
    ...(originalBytes > 0 ? { originalBytes } : {}),
    hint: "Narrow the request: use limit/offset, omit includeSource, or use a smaller tokenBudget.",
  });
  const response: McpResponse = {
    jsonrpc: "2.0",
    id,
    result: { isError: true, content: [{ type: "text", text }] },
  };
  return { response, bytes: wireBytes(response), truncated: true, dropped: {} };
}

/**
 * Serialize a structured tool payload as compact JSON inside a tool result,
 * keeping the whole JSON-RPC line within `maxBytes`.
 */
export function shapeToolResult(
  id: string | number | null,
  tool: string,
  payload: Record<string, unknown>,
  opts: { maxBytes?: number; shrink?: Shrinkable[] } = {}
): ShapedResult {
  const maxBytes = opts.maxBytes ?? getMaxResponseBytes();
  const shrink = opts.shrink ?? [];
  const budget = maxBytes - wrapperBytes(id);

  const base: Record<string, unknown> = { ...payload };
  const originals: unknown[][] = shrink.map((s) =>
    Array.isArray(payload[s.key]) ? (payload[s.key] as unknown[]) : []
  );
  for (const s of shrink) base[s.key] = [];

  const fixed = jsonEscapedBytes(JSON.stringify(base)) + METADATA_RESERVE_BYTES;
  if (fixed > budget) return overflowResponse(id, tool, maxBytes, 0);

  let avail = budget - fixed;
  const dropped: Record<string, number> = {};
  let truncated = false;
  shrink.forEach((s, i) => {
    const items = originals[i];
    const kept: unknown[] = [];
    for (const item of items) {
      const cost = jsonEscapedBytes(JSON.stringify(item)) + 1; // +1: the separating comma
      if (cost <= avail) {
        kept.push(item);
        avail -= cost;
        continue;
      }
      if (s.lighten) {
        const light = s.lighten(item);
        const lightCost = jsonEscapedBytes(JSON.stringify(light)) + 1;
        if (lightCost <= avail) {
          kept.push(light);
          avail -= lightCost;
          truncated = true;
          continue;
        }
      }
      break;
    }
    base[s.key] = kept;
    if (kept.length < items.length) {
      truncated = true;
      dropped[s.key] = items.length - kept.length;
      s.patch?.(kept.length, base);
    }
  });

  if (truncated) {
    base.truncated = true;
    base.outputLimit = { maxBytes, ...(Object.keys(dropped).length ? { dropped } : {}) };
  }

  const response = textResponse(id, JSON.stringify(base));
  const bytes = wireBytes(response);
  if (bytes > maxBytes) return overflowResponse(id, tool, maxBytes, bytes);
  return { response, bytes, truncated, dropped };
}

/**
 * Text tool result (a rendered prompt) bounded in wire bytes. Over-long text is
 * cut once at an escaped-byte boundary and ends with `notice`; `preserve`
 * (the user's task) must survive the cut or a minimal block carrying it is
 * returned instead.
 */
export function shapeTextResult(
  id: string | number | null,
  tool: string,
  text: string,
  opts: { maxBytes?: number; notice?: string; preserve?: string } = {}
): ShapedResult {
  const maxBytes = opts.maxBytes ?? getMaxResponseBytes();
  const budget = maxBytes - wrapperBytes(id);
  if (jsonEscapedBytes(text) <= budget) {
    const response = textResponse(id, text);
    return { response, bytes: wireBytes(response), truncated: false, dropped: {} };
  }
  const notice =
    opts.notice ??
    `\n\n[Output truncated at the ${maxBytes}-byte response limit; request less (smaller tokenBudget) to avoid this.]`;
  const noticeBytes = jsonEscapedBytes(notice);
  let cut = clipEscapedBytes(text, Math.max(0, budget - noticeBytes)) + notice;
  if (opts.preserve && !cut.includes(opts.preserve)) {
    const room = Math.max(0, budget - noticeBytes - 64);
    cut = `Task (preserved):\n${clipEscapedBytes(opts.preserve, room)}${notice}`;
  }
  const response = textResponse(id, cut);
  const bytes = wireBytes(response);
  if (bytes > maxBytes) return overflowResponse(id, tool, maxBytes, bytes);
  return { response, bytes, truncated: true, dropped: {} };
}

/**
 * Last-resort guard applied to every response leaving the protocol handler
 * (including errors): anything still over the ceiling is replaced by a small,
 * valid response that says so.
 */
export function finalizeResponse(response: McpResponse, maxBytes?: number): McpResponse {
  const max = maxBytes ?? getMaxResponseBytes();
  const size = wireBytes(response);
  if (size <= max) return response;
  if (response.error) {
    return {
      jsonrpc: "2.0",
      id: response.id,
      error: {
        code: response.error.code,
        message: clipChars(response.error.message, 500),
      },
    };
  }
  return overflowResponse(response.id, "unknown", max, size).response;
}
