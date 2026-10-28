import { handleMcpMessage, type McpResponse } from "../../core/mcp";

export interface ToolCall {
  res: McpResponse;
  /** UTF-8 bytes of the full JSON-RPC line exactly as the stdio server would write it. */
  bytes: number;
  /** `result.content[0].text`, when the call produced a result. */
  text: string;
  /** `text` parsed as JSON, or null for plain-text results (kai_get_context) and errors. */
  json: Record<string, any> | null;
  error?: { code: number; message: string };
}

let nextId = 1;

export async function callTool(
  root: string,
  name: string,
  args: Record<string, unknown> = {},
  id: string | number = nextId++
): Promise<ToolCall> {
  const res = await handleMcpMessage(
    { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
    root
  );
  if (!res) throw new Error("no response");
  const bytes = Buffer.byteLength(JSON.stringify(res), "utf8");
  const content = (res.result as { content?: Array<{ text: string }> } | undefined)?.content;
  const text = content?.[0]?.text ?? "";
  let json: Record<string, any> | null = null;
  try {
    const parsed = JSON.parse(text);
    json = parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    json = null;
  }
  return { res, bytes, text, json, error: res.error };
}
