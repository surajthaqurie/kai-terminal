import { IntegrationError } from "../integrations/types";
import { composeHtml, parseBody, sanitize } from "./html";

/**
 * A small Microsoft Graph client for Teams: joined teams and channels, chats,
 * messages (text and images) and sending. Nothing here prints or stores
 * anything; the CLI and the terminal UI sit on top.
 */

export const GRAPH_HOST = "graph.microsoft.com";
export const GRAPH_BASE = `https://${GRAPH_HOST}/v1.0`;

const TIMEOUT_MS = 25_000;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
/** Largest image downloaded for display. */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
/**
 * Graph's simple upload and hosted-content limit. A file at or under this size is sent in one
 * request; an inline image can never be larger (it travels inside the message itself).
 */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
/**
 * The most Kai uploads for one file (OneDrive upload session). Graph allows far more, but the
 * file is held in memory while it is sent.
 */
export const MAX_FILE_BYTES = 250 * 1024 * 1024;
/** Upload-session chunks must be a multiple of 320 KiB; 16 x 320 KiB = 5 MiB. */
export const UPLOAD_CHUNK_BYTES = 16 * 320 * 1024;
const CHUNK_TIMEOUT_MS = 120_000;
/** Failed attempts at one stretch of a file before the upload is given up. */
const MAX_CHUNK_FAILURES = 4;
const MAX_RETRIES = 2;
const MAX_PAGES = 3;

export interface GraphDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** True only for https://graph.microsoft.com/... so no other address is ever fetched with the token. */
export function isGraphUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === GRAPH_HOST && !u.username && !u.password;
  } catch {
    return false;
  }
}

interface GraphErrorBody {
  error?: { code?: unknown; message?: unknown };
}

function describe(text: string): { code: string; message: string } {
  try {
    const e = (JSON.parse(text) as GraphErrorBody).error;
    return {
      code: typeof e?.code === "string" ? e.code : "",
      message:
        typeof e?.message === "string"
          ? sanitize(e.message).replace(/\s+/g, " ").trim().slice(0, 300)
          : "",
    };
  } catch {
    return { code: "", message: "" };
  }
}

function toError(status: number, text: string): IntegrationError {
  const { code, message } = describe(text);
  const detail = message ? ` ${message}` : "";
  if (status === 401) {
    return new IntegrationError(
      "auth",
      "Your Microsoft Teams sign-in has expired.",
      "Run `kai integration teams` to sign in again."
    );
  }
  if (status === 403) {
    return new IntegrationError(
      "forbidden",
      `Microsoft Teams refused this request.${detail}`,
      "Your organization may need to approve this permission. Ask an administrator, or see docs/teams-sign-in.md."
    );
  }
  if (status === 404) {
    return new IntegrationError("not_found", `Not found.${detail}`);
  }
  if (status === 429) {
    return new IntegrationError(
      "rate_limited",
      "Microsoft is throttling requests.",
      "Retry shortly."
    );
  }
  return new IntegrationError(
    status >= 500 ? "network" : "bad_request",
    `HTTP ${status}${code ? ` (${code})` : ""}${detail}`
  );
}

interface RequestOptions {
  /** Raw request body (an upload); sent as-is with `contentType`. */
  raw?: Uint8Array;
  contentType?: string;
}

async function send(
  token: string,
  method: string,
  url: string,
  body: unknown,
  deps: GraphDeps,
  opts: RequestOptions,
  expect: "json" | "bytes",
  maxBytes: number
): Promise<{ status: number; data: Uint8Array; contentType: string }> {
  if (!isGraphUrl(url)) {
    throw new IntegrationError(
      "bad_request",
      "Refusing to call an address that is not Microsoft Graph."
    );
  }
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        accept: expect === "json" ? "application/json" : "*/*",
      };
      let payload: BodyInit | undefined;
      if (opts.raw) {
        headers["content-type"] = opts.contentType ?? "application/octet-stream";
        payload = opts.raw as unknown as BodyInit;
      } else if (body !== undefined) {
        headers["content-type"] = "application/json";
        payload = JSON.stringify(body);
      }
      res = await doFetch(url, {
        method,
        headers,
        body: payload,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const aborted = err instanceof Error && err.name === "AbortError";
      throw new IntegrationError(
        "network",
        aborted ? "Microsoft did not answer in time." : "Could not reach Microsoft Graph.",
        "Check the network connection."
      );
    }
    if (
      (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) &&
      attempt < MAX_RETRIES
    ) {
      clearTimeout(timer);
      const wait = Number(res.headers.get("retry-after"));
      await sleep(
        Math.min(Number.isFinite(wait) && wait > 0 ? wait * 1000 : 500 * 2 ** attempt, 8000)
      );
      continue;
    }
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      clearTimeout(timer);
      throw new IntegrationError("bad_request", "The response is too large to read safely.");
    }
    let data: Uint8Array;
    try {
      data = new Uint8Array(await res.arrayBuffer());
    } catch {
      throw new IntegrationError("network", "The connection dropped while reading the response.");
    } finally {
      clearTimeout(timer);
    }
    if (data.byteLength > maxBytes) {
      throw new IntegrationError("bad_request", "The response is too large to read safely.");
    }
    if (res.status >= 300 && res.status < 400) {
      throw new IntegrationError(
        "bad_request",
        "Microsoft Graph redirected the request, which is not allowed."
      );
    }
    if (!res.ok) throw toError(res.status, new TextDecoder().decode(data));
    return { status: res.status, data, contentType: res.headers.get("content-type") ?? "" };
  }
}

/** One Graph call that returns JSON (or nothing, for 204). */
export async function graphRequest<T>(
  token: string,
  method: "GET" | "POST" | "PUT",
  url: string,
  body: unknown,
  deps: GraphDeps = {},
  opts: RequestOptions = {}
): Promise<T> {
  const r = await send(token, method, url, body, deps, opts, "json", MAX_JSON_BYTES);
  if (r.status === 204 || r.data.byteLength === 0) return undefined as T;
  try {
    return JSON.parse(new TextDecoder().decode(r.data)) as T;
  } catch {
    throw new IntegrationError("bad_request", "Microsoft returned an unreadable response.");
  }
}

interface SessionReply {
  /** HTTP status, or 0 when the request never got an answer. */
  status: number;
  text: string;
}

/**
 * One request to an upload session address. That address is not on Graph and carries its own
 * authorization, so the bearer token is deliberately not sent. A dropped connection is reported as
 * status 0 so the caller can resume.
 */
async function sessionRequest(
  method: "PUT" | "GET" | "DELETE",
  url: string,
  deps: GraphDeps,
  chunk?: { bytes: Uint8Array; start: number; total: number }
): Promise<SessionReply> {
  const doFetch = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHUNK_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (chunk) {
      headers["content-length"] = String(chunk.bytes.byteLength);
      headers["content-range"] =
        `bytes ${chunk.start}-${chunk.start + chunk.bytes.byteLength - 1}/${chunk.total}`;
    }
    const res = await doFetch(url, {
      method,
      headers,
      body: chunk ? (chunk.bytes as unknown as BodyInit) : undefined,
      redirect: "manual",
      signal: controller.signal,
    });
    const raw = new Uint8Array(await res.arrayBuffer()).subarray(0, MAX_JSON_BYTES);
    return { status: res.status, text: new TextDecoder().decode(raw) };
  } catch {
    return { status: 0, text: "" };
  } finally {
    clearTimeout(timer);
  }
}

/** The first byte OneDrive still wants, from `nextExpectedRanges` (["5242880-"]), or null. */
function nextExpectedOffset(text: string): number | null {
  try {
    const ranges = (JSON.parse(text) as { nextExpectedRanges?: unknown }).nextExpectedRanges;
    if (!Array.isArray(ranges) || typeof ranges[0] !== "string") return null;
    const n = Number.parseInt(ranges[0].split("-")[0], 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/** True for an address an upload session may legitimately hand out: https, no embedded credentials. */
function isUploadSessionUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** Download bytes (an image) from Graph. */
export async function graphBytes(
  token: string,
  url: string,
  deps: GraphDeps = {},
  maxBytes = MAX_IMAGE_BYTES
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const r = await send(token, "GET", url, undefined, deps, {}, "bytes", maxBytes);
  return { bytes: r.data, contentType: r.contentType };
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface TeamInfo {
  id: string;
  name: string;
}
export interface ChannelInfo {
  id: string;
  name: string;
}
export interface ChatInfo {
  id: string;
  title: string;
  kind: "oneOnOne" | "group" | "meeting" | "other";
  /** When the newest message was sent (ISO), or "" when the chat is empty. */
  lastAt: string;
  /** Who sent the newest message; empty for apps and system lines. */
  lastFromId: string;
  /** When you last read the chat in any Teams client (ISO), or "". */
  lastReadAt: string;
}

/** One page of a conversation's messages, oldest first. */
export interface MessagePage {
  messages: TeamsMessage[];
  /** The address of the next OLDER page, or null when there is none. */
  next: string | null;
}

export type Target =
  { kind: "channel"; teamId: string; channelId: string } | { kind: "chat"; chatId: string };

export interface MessageImage {
  /** Graph hosted-content address, or another address that cannot be fetched with the token. */
  url: string;
  alt: string;
  /** True when the token may fetch it (a Graph address). */
  fetchable: boolean;
}

export interface MessageFile {
  name: string;
  url?: string;
}

export interface TeamsMessage {
  id: string;
  at: string;
  from: string;
  /** Microsoft Entra id of the sender; empty for apps and system lines. */
  fromId: string;
  text: string;
  images: MessageImage[];
  files: MessageFile[];
  /** A system line (member joined, call ended). */
  system: boolean;
  /** Set on a message that is still being sent from here (not yet confirmed by Teams). */
  pending?: boolean;
}

export interface OutgoingImage {
  name: string;
  bytes: Uint8Array;
  contentType: string;
}

export interface Draft {
  text: string;
  images: OutgoingImage[];
  links: Array<{ name: string; url: string }>;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === "object" && v !== null ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function mapMessage(raw: unknown): TeamsMessage | null {
  const m = obj(raw);
  const id = str(m.id);
  if (!id || m.deletedDateTime) return null;
  const body = obj(m.body);
  const parsed = parseBody(str(body.content), str(body.contentType).toLowerCase() === "html");
  const from = obj(m.from);
  const who =
    str(obj(from.user).displayName) ||
    str(obj(from.application).displayName) ||
    str(obj(from.device).displayName);
  const files: MessageFile[] = arr(m.attachments)
    .map(obj)
    .filter((a) => str(a.name))
    .map((a) => ({
      name: sanitize(str(a.name)),
      ...(str(a.contentUrl) ? { url: str(a.contentUrl) } : {}),
    }));
  return {
    id,
    at: str(m.createdDateTime),
    from: sanitize(who) || "system",
    fromId: str(obj(from.user).id),
    text: parsed.text,
    images: parsed.images.map((i) => ({
      url: i.url,
      alt: sanitize(i.alt),
      fetchable: isGraphUrl(i.url),
    })),
    files,
    system: str(m.messageType) !== "" && str(m.messageType) !== "message",
  };
}

function chatKind(v: string): ChatInfo["kind"] {
  return v === "oneOnOne" || v === "group" || v === "meeting" ? v : "other";
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class GraphClient {
  constructor(
    private readonly token: () => Promise<string>,
    private readonly deps: GraphDeps = {}
  ) {}

  private async get<T>(url: string): Promise<T> {
    return graphRequest<T>(await this.token(), "GET", url, undefined, this.deps);
  }

  /** Follow `@odata.nextLink` for at most a few pages. */
  private async pages(url: string): Promise<unknown[]> {
    const out: unknown[] = [];
    let next: string | undefined = url;
    for (let i = 0; next && i < MAX_PAGES; i++) {
      const page: Json = obj(await this.get<unknown>(next));
      out.push(...arr(page.value));
      const link = str(page["@odata.nextLink"]);
      next = link && isGraphUrl(link) ? link : undefined;
    }
    return out;
  }

  /** The signed-in user's profile. */
  async me(): Promise<{ id: string; name: string; email?: string }> {
    const m = obj(await this.get<unknown>(`${GRAPH_BASE}/me`));
    const email = str(m.mail) || str(m.userPrincipalName);
    return {
      id: str(m.id),
      name: sanitize(str(m.displayName)) || email,
      ...(email ? { email } : {}),
    };
  }

  async joinedTeams(): Promise<TeamInfo[]> {
    const rows = await this.pages(`${GRAPH_BASE}/me/joinedTeams`);
    return rows
      .map(obj)
      .filter((t) => str(t.id))
      .map((t) => ({ id: str(t.id), name: sanitize(str(t.displayName)) || "(unnamed team)" }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async channels(teamId: string): Promise<ChannelInfo[]> {
    const rows = await this.pages(`${GRAPH_BASE}/teams/${encodeURIComponent(teamId)}/channels`);
    return rows
      .map(obj)
      .filter((c) => str(c.id))
      .map((c) => ({ id: str(c.id), name: sanitize(str(c.displayName)) || "(unnamed)" }));
  }

  async chats(myId: string): Promise<ChatInfo[]> {
    const rows = await this.pages(
      `${GRAPH_BASE}/me/chats?$expand=members,lastMessagePreview&$orderby=lastMessagePreview/createdDateTime desc&$top=50`
    );
    return rows
      .map(obj)
      .filter((c) => str(c.id))
      .map((c) => {
        const kind = chatKind(str(c.chatType));
        const others = arr(c.members)
          .map(obj)
          .filter((m) => str(m.userId) !== myId)
          .map((m) => sanitize(str(m.displayName)))
          .filter(Boolean);
        const topic = sanitize(str(c.topic));
        const names =
          others.length > 3
            ? `${others.slice(0, 3).join(", ")} +${others.length - 3}`
            : others.join(", ");
        const preview = obj(c.lastMessagePreview);
        return {
          id: str(c.id),
          kind,
          title: topic || names || (kind === "meeting" ? "Meeting chat" : "Chat"),
          lastAt: str(preview.createdDateTime),
          lastFromId: str(obj(obj(preview.from).user).id),
          lastReadAt: str(obj(c.viewpoint).lastMessageReadDateTime),
        };
      });
  }

  /** The latest messages of a conversation, oldest first. */
  async messages(target: Target, top = 30): Promise<TeamsMessage[]> {
    return (await this.messagesPage(target, { top })).messages;
  }

  /**
   * One page of a conversation, oldest first, with the address of the next
   * OLDER page. Pass `pageUrl` (a previous `next`) to go further back.
   */
  async messagesPage(
    target: Target,
    opts: { top?: number; pageUrl?: string } = {}
  ): Promise<MessagePage> {
    let url: string;
    if (opts.pageUrl !== undefined) {
      if (!isGraphUrl(opts.pageUrl)) {
        throw new IntegrationError(
          "bad_request",
          "Refusing to follow an address that is not Microsoft Graph."
        );
      }
      url = opts.pageUrl;
    } else {
      const base =
        target.kind === "channel"
          ? `${GRAPH_BASE}/teams/${encodeURIComponent(target.teamId)}/channels/${encodeURIComponent(target.channelId)}/messages`
          : `${GRAPH_BASE}/chats/${encodeURIComponent(target.chatId)}/messages`;
      url = `${base}?$top=${Math.min(Math.max(opts.top ?? 30, 1), 50)}`;
    }
    const page = obj(await this.get<unknown>(url));
    const link = str(page["@odata.nextLink"]);
    return {
      messages: arr(page.value)
        .map(mapMessage)
        .filter((m): m is TeamsMessage => m !== null)
        .sort((a, b) => a.at.localeCompare(b.at)),
      next: link && isGraphUrl(link) ? link : null,
    };
  }

  /** Download an inline image shown in a message. */
  async image(url: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    return graphBytes(await this.token(), url, this.deps);
  }

  /**
   * Upload a file to the user's OneDrive and return a link people in the organization can open.
   * Up to 4 MB goes in one request; anything larger is sent in chunks through an upload session,
   * resuming from where OneDrive says it stopped when a chunk fails. `onProgress` is told how many
   * bytes have been accepted so far.
   */
  async uploadFile(
    name: string,
    bytes: Uint8Array,
    onProgress?: (sent: number, total: number) => void
  ): Promise<string> {
    if (bytes.byteLength > MAX_FILE_BYTES) {
      throw new IntegrationError(
        "bad_request",
        `${name} is larger than ${MAX_FILE_BYTES / (1024 * 1024)} MB, which is the most Kai can upload.`
      );
    }
    const token = await this.token();
    const safe = encodeURIComponent(name.replace(/[\\/:*?"<>|#%]/g, "_"));
    const item =
      bytes.byteLength <= MAX_UPLOAD_BYTES
        ? obj(
            await graphRequest<unknown>(
              token,
              "PUT",
              `${GRAPH_BASE}/me/drive/root:/Kai%20Teams/${safe}:/content`,
              undefined,
              this.deps,
              { raw: bytes }
            )
          )
        : await this.uploadInChunks(token, safe, bytes, onProgress);
    const id = str(item.id);
    if (!id)
      throw new IntegrationError("bad_request", "OneDrive did not return the uploaded file.");
    const link = obj(
      await graphRequest<unknown>(
        token,
        "POST",
        `${GRAPH_BASE}/me/drive/items/${encodeURIComponent(id)}/createLink`,
        { type: "view", scope: "organization" },
        this.deps
      )
    );
    const url = str(obj(link.link).webUrl);
    if (!url) throw new IntegrationError("bad_request", "OneDrive did not return a share link.");
    return url;
  }

  /** An upload session: PUT the file in chunks, ask where to resume after a failure, give up after a few. */
  private async uploadInChunks(
    token: string,
    safeName: string,
    bytes: Uint8Array,
    onProgress?: (sent: number, total: number) => void
  ): Promise<Json> {
    const sleep = this.deps.sleep ?? defaultSleep;
    const total = bytes.byteLength;
    const session = obj(
      await graphRequest<unknown>(
        token,
        "POST",
        `${GRAPH_BASE}/me/drive/root:/Kai%20Teams/${safeName}:/createUploadSession`,
        { item: { "@microsoft.graph.conflictBehavior": "rename" } },
        this.deps
      )
    );
    const uploadUrl = str(session.uploadUrl);
    if (!uploadUrl || !isUploadSessionUrl(uploadUrl)) {
      throw new IntegrationError("bad_request", "OneDrive did not return a usable upload address.");
    }
    const fail = async (err: IntegrationError): Promise<never> => {
      await sessionRequest("DELETE", uploadUrl, this.deps); // best effort: free the half-uploaded file
      throw err;
    };

    let offset = 0;
    let failures = 0;
    onProgress?.(0, total);
    while (true) {
      const end = Math.min(offset + UPLOAD_CHUNK_BYTES, total);
      const reply = await sessionRequest("PUT", uploadUrl, this.deps, {
        bytes: bytes.subarray(offset, end),
        start: offset,
        total,
      });
      if (reply.status === 200 || reply.status === 201) {
        onProgress?.(total, total);
        try {
          return obj(JSON.parse(reply.text)) as Json;
        } catch {
          return fail(
            new IntegrationError("bad_request", "OneDrive returned an unreadable response.")
          );
        }
      }
      if (reply.status === 202) {
        const next = nextExpectedOffset(reply.text) ?? end;
        if (next > offset && next <= total) {
          failures = 0;
          offset = next;
          onProgress?.(offset, total);
          continue;
        }
        failures++; // OneDrive did not move forward
      } else if (
        reply.status === 0 ||
        reply.status === 416 ||
        reply.status === 429 ||
        reply.status >= 500
      ) {
        failures++;
      } else if (reply.status === 404) {
        return fail(
          new IntegrationError(
            "bad_request",
            "The upload expired before it finished. Send the file again."
          )
        );
      } else {
        return fail(toError(reply.status, reply.text));
      }
      if (failures > MAX_CHUNK_FAILURES) {
        return fail(
          new IntegrationError(
            "network",
            "The upload kept failing and was stopped.",
            "Check the network connection and send the file again."
          )
        );
      }
      await sleep(Math.min(500 * 2 ** (failures - 1), 8000));
      // Ask OneDrive what it already has, so a chunk that arrived before the connection dropped is not repeated.
      const status = await sessionRequest("GET", uploadUrl, this.deps);
      if (status.status === 200) {
        const resume = nextExpectedOffset(status.text);
        if (resume !== null && resume <= total) offset = resume;
      }
    }
  }

  /** Post a message with any inline images. */
  async send(target: Target, draft: Draft): Promise<void> {
    const url =
      target.kind === "channel"
        ? `${GRAPH_BASE}/teams/${encodeURIComponent(target.teamId)}/channels/${encodeURIComponent(target.channelId)}/messages`
        : `${GRAPH_BASE}/chats/${encodeURIComponent(target.chatId)}/messages`;
    const content = composeHtml(draft.text, draft.images.length, draft.links);
    if (!content) throw new IntegrationError("bad_request", "There is nothing to send.");
    const body: Json = { body: { contentType: "html", content } };
    if (draft.images.length > 0) {
      body.hostedContents = draft.images.map((img, i) => ({
        "@microsoft.graph.temporaryId": String(i + 1),
        contentBytes: Buffer.from(img.bytes).toString("base64"),
        contentType: img.contentType,
      }));
    }
    await graphRequest<unknown>(await this.token(), "POST", url, body, this.deps);
  }
}
