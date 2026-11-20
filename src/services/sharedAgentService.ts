import { invoke } from "@tauri-apps/api/core";
import { isTauriAvailable } from "./ptyService";
import type {
  AgentView,
  CreatedInvite,
  DeviceGrants,
  DeviceHistory,
  InviteMinutes,
  JoinedHost,
  SharedAgentErrorBody,
  SharedAgentEvent,
  SharedAgentId,
  SharedAgentRequest,
  SharedAgentResponse,
  ShareStatus,
} from "../core/sharedAgent/types";

/** Event the desktop shell forwards for every line the Shared Agent service pushes. */
export const SHARED_AGENT_EVENT = "kai-shared-agent:event";

type Failure = { ok: false; error: SharedAgentErrorBody };
export type SharedResult<T> = { ok: true; value: T } | Failure;

const unavailable = (message: string): Failure => ({
  ok: false,
  error: { code: "unavailable", message },
});

function isFailure(v: unknown): v is Failure {
  const e = (v as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { ok?: unknown }).ok === false &&
    typeof e?.code === "string" &&
    typeof e?.message === "string"
  );
}

/**
 * One request to the Shared Agent service through the desktop shell. The service
 * owns every rule and all networking (the webview cannot reach the LAN); this only
 * moves JSON. Never throws: outside the desktop app, on an IPC failure or on a
 * malformed reply it resolves with an `unavailable` error the UI can show.
 */
export async function sharedAgentRpc(req: SharedAgentRequest): Promise<SharedAgentResponse> {
  if (!isTauriAvailable()) {
    return unavailable("Shared Agent is part of the desktop app. Open Kai Terminal to use it.");
  }
  let raw: string;
  try {
    raw = await invoke<string>("shared_agent_request_cmd", { requestJson: JSON.stringify(req) });
  } catch (err) {
    // The Rust side never puts the request in its messages.
    return unavailable(typeof err === "string" && err ? err : "Could not reach the kai CLI.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unavailable("The Shared Agent service returned an unreadable response.");
  }
  const ok = (parsed as { ok?: unknown } | null)?.ok;
  if (typeof parsed !== "object" || parsed === null || typeof ok !== "boolean") {
    return unavailable("The Shared Agent service returned an unexpected response.");
  }
  if (ok === false && !isFailure(parsed)) {
    return unavailable("The Shared Agent service reported an error without details.");
  }
  return parsed as SharedAgentResponse;
}

function pick<T>(res: SharedAgentResponse, key: string): SharedResult<T> {
  if (!res.ok) return res;
  const body = res as unknown as Record<string, unknown>;
  if (body[key] === undefined)
    return unavailable("The Shared Agent service returned an unexpected response.");
  return { ok: true, value: body[key] as T };
}

const done = (res: SharedAgentResponse): SharedResult<true> =>
  res.ok ? { ok: true, value: true } : res;

// ---------------------------------------------------------------------------
// Receive: PCs this PC has joined, and chat
// ---------------------------------------------------------------------------

export async function listHosts(
  refresh = false
): Promise<SharedResult<{ hosts: JoinedHost[]; ownAgents: AgentView[] }>> {
  const res = await sharedAgentRpc({ op: "hosts_list", refresh });
  if (!res.ok) return res;
  const b = res as { hosts?: JoinedHost[]; ownAgents?: AgentView[] };
  if (!Array.isArray(b.hosts) || !Array.isArray(b.ownAgents)) {
    return unavailable("The Shared Agent service returned an unexpected response.");
  }
  return { ok: true, value: { hosts: b.hosts, ownAgents: b.ownAgents } };
}

export async function joinHost(link: string, name?: string): Promise<SharedResult<JoinedHost>> {
  return pick<JoinedHost>(await sharedAgentRpc({ op: "host_join", link, name }), "host");
}

export async function leaveHost(hostId: string): Promise<SharedResult<true>> {
  return done(await sharedAgentRpc({ op: "host_leave", hostId }));
}

export interface ChatSendInput {
  chatId: string;
  hostId: string | null;
  agent: SharedAgentId;
  message: string;
  session: string | null;
}

/** Starts a chat turn. The answer streams back as `chat` events. */
export async function sendChat(input: ChatSendInput): Promise<SharedResult<string>> {
  return pick<string>(await sharedAgentRpc({ op: "chat_send", ...input }), "chatId");
}

export async function stopChat(chatId: string): Promise<SharedResult<true>> {
  return done(await sharedAgentRpc({ op: "chat_stop", chatId }));
}

// ---------------------------------------------------------------------------
// Share: this PC as a host
// ---------------------------------------------------------------------------

const share = async (req: SharedAgentRequest) =>
  pick<ShareStatus>(await sharedAgentRpc(req), "share");

export const getShareStatus = (refresh = false) => share({ op: "share_status", refresh });
export const setSharing = (enabled: boolean) => share({ op: "share_set", enabled });
export const setAgentShared = (agent: SharedAgentId, enabled: boolean) =>
  share({ op: "share_agent", agent, enabled });
export const setPublicUrl = (url: string | null) => share({ op: "share_public_url", url });
export const cancelInvite = (id: string) => share({ op: "invite_cancel", id });
export const disconnectDevice = (id: string) => share({ op: "device_disconnect", id });
export const removeDevice = (id: string) => share({ op: "device_remove", id });
export const stopHostRun = (runId: string) => share({ op: "run_stop", runId });
export const setDeviceGrants = (id: string, grants: DeviceGrants) =>
  share({ op: "device_grants", id, grants });

export async function getDeviceHistory(id: string): Promise<SharedResult<DeviceHistory>> {
  return pick<DeviceHistory>(await sharedAgentRpc({ op: "device_history", id }), "history");
}

export async function createInvite(
  expiresMinutes: InviteMinutes
): Promise<SharedResult<{ share: ShareStatus; invite: CreatedInvite }>> {
  const res = await sharedAgentRpc({ op: "invite_create", expiresMinutes });
  if (!res.ok) return res;
  const b = res as { share?: ShareStatus; invite?: CreatedInvite };
  if (!b.share || !b.invite)
    return unavailable("The Shared Agent service returned an unexpected response.");
  return { ok: true, value: { share: b.share, invite: b.invite } };
}

// ---------------------------------------------------------------------------
// Events and lifecycle
// ---------------------------------------------------------------------------

/** Subscribes to everything the service pushes (chat text, joined-PC changes, ...). */
export async function onSharedAgentEvent(
  handler: (event: SharedAgentEvent) => void
): Promise<() => void> {
  if (!isTauriAvailable()) return () => {};
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<string>(SHARED_AGENT_EVENT, (e) => {
      if (typeof e.payload !== "string") return;
      try {
        const parsed = JSON.parse(e.payload) as SharedAgentEvent;
        if (parsed && typeof (parsed as { event?: unknown }).event === "string") handler(parsed);
      } catch {
        // A malformed line is ignored.
      }
    });
  } catch {
    return () => {};
  }
}

/** Stops the service: sharing ends and every run is stopped. */
export async function stopSharedAgentService(): Promise<boolean> {
  if (!isTauriAvailable()) return false;
  try {
    return await invoke<boolean>("shared_agent_stop_cmd");
  } catch {
    return false;
  }
}
