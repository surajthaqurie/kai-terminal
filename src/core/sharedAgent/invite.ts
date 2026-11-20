/**
 * Invite links. Two shapes:
 *  - LAN:      `http://<private-ip>:<port>/join#<secret>.<host fingerprint>`
 *  - Internet: `https://<tunnel-host>/join#<secret>.<host fingerprint>` (the
 *    public address of any HTTPS tunnel or reverse proxy the host set up).
 *
 * Both parts ride in the #fragment, so no server, proxy, tunnel or log ever
 * sees them. Neither is ever sent: the secret only keys the pairing handshake
 * and the fingerprint pins the host's identity key (see `secureChannel.ts`),
 * so a tunnel provider or anyone on the LAN can neither join with a link it
 * relayed nor pose as the host.
 * Pure functions (no Node imports): the desktop UI validates a pasted link
 * with the same code the service uses.
 */

export interface InviteTarget {
  /** Where the host answers, e.g. `http://192.168.1.20:8765` or `https://my-pc.example.com`. */
  origin: string;
  key: string;
  /** SHA-256 of the host's identity key, base64url: the host must prove it holds that key. */
  fingerprint: string;
  /** True for an internet (tunnel) link. */
  tunnel: boolean;
}

/** The secret: 256 bits, base64url. */
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
/** A SHA-256 fingerprint, base64url. */
const FINGERPRINT_RE = /^[A-Za-z0-9_-]{43}$/;

/** Dotted-quad IPv4 as four numbers, or null. */
export function parseIPv4(value: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value.trim());
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (parts.some((p) => p > 255)) return null;
  return parts as [number, number, number, number];
}

/** A private-network (or loopback) IPv4 address: the only kind a LAN host may have. */
export function isPrivateIPv4(value: string): boolean {
  const ip = parseIPv4(value);
  if (!ip) return false;
  const [a, b] = ip;
  if (a === 127) return true; // loopback
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return a === 192 && b === 168;
}

const DNS_NAME_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** A public DNS name a tunnel could have: not an IP, not localhost, has a dot. */
function isPublicHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (!DNS_NAME_RE.test(h)) return false;
  return !(h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local"));
}

/**
 * Which hosts this PC may contact: `http` to a private IPv4 address (LAN), or
 * `https` to a public DNS name (a tunnel). Returns the canonical origin or null.
 */
export function allowedOrigin(value: string): { origin: string; tunnel: boolean } | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "http:" && isPrivateIPv4(url.hostname)) {
    return { origin: url.origin, tunnel: false };
  }
  if (url.protocol === "https:" && isPublicHostname(url.hostname)) {
    return { origin: url.origin, tunnel: true };
  }
  return null;
}

/**
 * Validates the tunnel address the host pastes. Returns its origin
 * (`https://my-pc.example.com`) or null.
 */
export function parsePublicUrl(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return null;
  const allowed = allowedOrigin(url.href);
  return allowed?.tunnel ? allowed.origin : null;
}

export function buildInviteLink(origin: string, key: string, fingerprint: string): string {
  return `${origin.replace(/\/+$/, "")}/join#${key}.${fingerprint}`;
}

/** Parses a pasted link. Returns null for anything that is not a well-formed invite. */
export function parseInviteLink(text: string): InviteTarget | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.pathname !== "/join" || url.search) return null;
  const allowed = allowedOrigin(url.href);
  if (!allowed) return null;
  const [key, fingerprint, ...rest] = url.hash.replace(/^#/, "").split(".");
  if (rest.length || !KEY_RE.test(key ?? "") || !FINGERPRINT_RE.test(fingerprint ?? ""))
    return null;
  return { origin: allowed.origin, key, fingerprint, tunnel: allowed.tunnel };
}
