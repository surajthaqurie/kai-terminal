/**
 * Turns an agent's machine-readable output into the small set of display
 * events the wire protocol carries (`text`, `tool`, `tool_result`, ...).
 * Pure: no process or network access, so it is tested with recorded lines.
 */
import { emptyTokens, type SharedAgentId, type TokenTotals } from "./types";

/** One display event, before the run stamps it with `seq` and `t`. */
export type EventBody = { type: string } & Record<string, unknown>;

/** What a run learns while its output is parsed. */
export interface ParseState {
  /** The agent's own session id, used to resume the conversation. */
  sessionId?: string;
  ok?: boolean;
  error?: string;
  costUsd?: number | null;
  tokens: TokenTotals;
  denied: Set<string>;
}

export const newParseState = (): ParseState => ({ tokens: emptyTokens(), denied: new Set() });

/** Token totals as the wire protocol spells them (snake_case, like Agent Bridge). */
export const toWireTokens = (t: TokenTotals) => ({
  input: t.input,
  output: t.output,
  cache_read: t.cacheRead,
  cache_write: t.cacheWrite,
});

/** Reads a wire `tokens` object (from Kai or Agent Bridge) defensively. */
export function fromWireTokens(raw: unknown): TokenTotals {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    input: count(r.input),
    output: count(r.output),
    cacheRead: count(r.cache_read),
    cacheWrite: count(r.cache_write),
  };
}

export function clip(value: unknown, limit: number): string {
  const raw = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  const text = raw.replace(/\r\n/g, "\n");
  return text.length <= limit ? text : `${text.slice(0, limit)}… (+${text.length - limit} chars)`;
}

const SUMMARY_KEYS = [
  "command",
  "file_path",
  "filePath",
  "path",
  "pattern",
  "url",
  "query",
  "description",
  "prompt",
];

export function summarizeInput(data: unknown): string {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const rec = data as Record<string, unknown>;
    for (const key of SUMMARY_KEYS) if (rec[key]) return clip(String(rec[key]), 200);
    return Object.keys(rec).length ? clip(rec, 200) : "";
  }
  return data ? clip(data, 200) : "";
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && typeof c === "object" && (c as { type?: unknown }).type === "text")
      .map((c) => String((c as { text?: unknown }).text ?? ""))
      .join("\n");
  }
  return "";
}

const count = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;

function addTokens(state: ParseState, t: Partial<TokenTotals>): void {
  state.tokens.input += count(t.input);
  state.tokens.output += count(t.output);
  state.tokens.cacheRead += count(t.cacheRead);
  state.tokens.cacheWrite += count(t.cacheWrite);
}

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Claude Code `--output-format stream-json` lines. */
export function parseClaude(obj: Record<string, unknown>, state: ParseState): EventBody[] {
  const kind = obj.type;
  const events: EventBody[] = [];
  if (kind === "system") {
    if (obj.subtype === "init") {
      const id = typeof obj.session_id === "string" ? obj.session_id : undefined;
      state.sessionId = id;
      events.push({ type: "session", session_id: id ?? null, model: String(obj.model ?? "") });
    } else if (obj.subtype === "permission_denied") {
      if (typeof obj.tool_use_id === "string") state.denied.add(obj.tool_use_id);
      events.push({
        type: "denied",
        tool: String(obj.tool_name ?? "tool"),
        text: "Blocked: shared agents are read-only",
      });
    }
    return events;
  }
  if (obj.parent_tool_use_id) return events; // inner steps of a sub-agent
  const content = rec(obj.message).content;
  const blocks = Array.isArray(content) ? content : [];
  if (kind === "assistant") {
    for (const raw of blocks) {
      const block = rec(raw);
      if (block.type === "text" && String(block.text ?? "").trim()) {
        events.push({ type: "text", text: String(block.text) });
      } else if (block.type === "tool_use") {
        events.push({
          type: "tool",
          name: String(block.name ?? "tool"),
          detail: summarizeInput(block.input),
        });
      }
    }
  } else if (kind === "user") {
    for (const raw of blocks) {
      const block = rec(raw);
      if (block.type !== "tool_result") continue;
      if (typeof block.tool_use_id === "string" && state.denied.has(block.tool_use_id)) continue;
      events.push({
        type: "tool_result",
        error: Boolean(block.is_error),
        text: clip(blockText(block.content), 1500),
      });
    }
  } else if (kind === "result") {
    state.ok = obj.subtype === "success" && !obj.is_error;
    state.costUsd = typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : null;
    const usage = rec(obj.usage);
    addTokens(state, {
      input: count(usage.input_tokens),
      output: count(usage.output_tokens),
      cacheRead: count(usage.cache_read_input_tokens),
      cacheWrite: count(usage.cache_creation_input_tokens),
    });
    if (!state.ok) state.error = clip(obj.result || obj.subtype || "failed", 500);
  }
  return events;
}

/** OpenCode `run --format json` lines. */
export function parseOpencode(obj: Record<string, unknown>, state: ParseState): EventBody[] {
  const events: EventBody[] = [];
  const session = obj.sessionID;
  if (typeof session === "string" && !state.sessionId) {
    state.sessionId = session;
    events.push({ type: "session", session_id: session, model: "" });
  }
  const part = rec(obj.part);
  if (obj.type === "text") {
    if (String(part.text ?? "").trim()) events.push({ type: "text", text: String(part.text) });
  } else if (obj.type === "tool_use") {
    const st = rec(part.state);
    events.push({
      type: "tool",
      name: String(part.tool ?? "tool"),
      detail: summarizeInput(st.input),
    });
    if (st.status === "error") {
      events.push({
        type: "tool_result",
        error: true,
        text: clip(st.error || "tool failed", 1500),
      });
    } else if (st.status === "completed") {
      const output = st.output ?? st.result;
      if (output !== undefined && output !== null && output !== "") {
        events.push({ type: "tool_result", error: false, text: clip(output, 1500) });
      }
    }
  } else if (obj.type === "step_finish") {
    if (typeof part.cost === "number") state.costUsd = (state.costUsd ?? 0) + part.cost;
    const tokens = rec(part.tokens);
    const cache = rec(tokens.cache);
    // Reasoning is billed as output.
    addTokens(state, {
      input: count(tokens.input),
      output: count(tokens.output) + count(tokens.reasoning),
      cacheRead: count(cache.read),
      cacheWrite: count(cache.write),
    });
  } else if (obj.type === "error") {
    const err = rec(obj.error ?? part.error);
    const text = String(rec(err.data).message ?? err.name ?? "error");
    state.ok = false;
    state.error = clip(text, 500);
    events.push({ type: "error", text: state.error });
  }
  return events;
}

export function parserFor(
  agent: SharedAgentId
): (obj: Record<string, unknown>, state: ParseState) => EventBody[] {
  return agent === "claude" ? parseClaude : parseOpencode;
}
