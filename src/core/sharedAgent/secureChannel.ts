/**
 * Kai Secure Channel (`kai-sc-1`): end-to-end encryption and mutual
 * authentication between a Kai client and a Kai host, on top of whatever
 * carries the bytes (plain HTTP on a LAN, ngrok, Cloudflare Tunnel, any
 * reverse proxy). The transport is treated as hostile: it sees only
 * ciphertext, a session id, a device id and message sizes and timing.
 *
 * Keys (X25519):
 *  - The host has one long-lived identity key. Its fingerprint travels in the
 *    invite link's #fragment (never sent to any server), so a joining PC knows
 *    which host it must be talking to before anything is sent.
 *  - Each joined PC makes its own key for that host. Only the public half is
 *    sent (encrypted) at pairing; nothing reusable ever crosses the wire, so
 *    there is no bearer token to steal.
 *  - Every session also uses fresh ephemeral keys on both sides (forward secrecy).
 *
 * Handshake (one round trip, `POST /api/sc/hello`):
 *  pair:   ikm = DH(e_c, H) | DH(e_c, e_h) | PSK(invite secret)
 *  device: ikm = DH(e_c, H) | DH(e_c, e_h) | DH(C, H) | DH(C, e_h)
 *  keys    = HKDF-SHA256(ikm, salt = SHA-256(transcript)) -> client->host, host->client
 * The host answers with its ephemeral key and an AEAD "confirm" under the new
 * keys, which only the holder of H's private key can produce. A device's
 * first sealed call proves it holds C (or, when pairing, the invite secret).
 *
 * Messages (`POST /api/sc/call`): AES-256-GCM, a per-direction key, a 64-bit
 * counter nonce, the session id and direction in the AAD, and a replay window
 * on the host. A reply reuses its request's counter under the other key.
 *
 * Built only from Node's `crypto` (X25519, HKDF, AES-GCM, SHA-256, HMAC).
 */
import crypto from "crypto";

export const PROTOCOL = "kai-sc-1";
const KEY_BYTES = 32;
const TAG_BYTES = 16;
const NONCE_BYTES = 12;

export type HandshakeMode = "pair" | "device";

// ---------------------------------------------------------------- encoding

export const b64u = (buf: Uint8Array): string => Buffer.from(buf).toString("base64url");

const B64U_RE = /^[A-Za-z0-9_-]+$/;

/** Decodes base64url of exactly `bytes` bytes (when given), or throws. */
export function fromB64u(value: unknown, bytes?: number): Buffer {
  if (typeof value !== "string" || !B64U_RE.test(value)) throw new ChannelError("bad encoding");
  const buf = Buffer.from(value, "base64url");
  if (bytes !== undefined && buf.length !== bytes) throw new ChannelError("bad length");
  return buf;
}

export class ChannelError extends Error {}

// ---------------------------------------------------------------- keys

export interface KeyPair {
  /** Raw 32-byte public key, base64url. */
  publicKey: string;
  /** Raw 32-byte private key, base64url. Goes only to the OS secret store or memory. */
  privateKey: string;
}

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  const jwk = privateKey.export({ format: "jwk" });
  const pub = publicKey.export({ format: "jwk" });
  if (!jwk.d || !pub.x) throw new ChannelError("key generation failed");
  return { publicKey: pub.x, privateKey: jwk.d };
}

// Fixed DER headers for raw X25519 keys (RFC 8410). Importing as DER works the
// same on every Node/OpenSSL build; a JWK private key without its matching `x`
// is rejected by some (it failed every handshake on macOS CI).
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");

function privateKeyObject(privateKey: string): crypto.KeyObject {
  const raw = fromB64u(privateKey, KEY_BYTES);
  return crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_X25519, raw]),
    format: "der",
    type: "pkcs8",
  });
}

function publicKeyObject(publicKey: string): crypto.KeyObject {
  const raw = fromB64u(publicKey, KEY_BYTES);
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_X25519, raw]),
    format: "der",
    type: "spki",
  });
}

/** Rebuilds a key pair from its stored private half (the public half is derived). */
export function keyPairFromPrivate(privateKey: string): KeyPair {
  const pub = crypto.createPublicKey(privateKeyObject(privateKey)).export({ format: "jwk" });
  if (!pub.x) throw new ChannelError("bad private key");
  return { publicKey: pub.x, privateKey };
}

function dh(privateKey: string, publicKey: string): Buffer {
  const pub = publicKeyObject(publicKey);
  const priv = privateKeyObject(privateKey);
  const shared = crypto.diffieHellman({ privateKey: priv, publicKey: pub });
  // An all-zero result means a low-order public key: refuse it.
  if (shared.every((b) => b === 0)) throw new ChannelError("weak key");
  return shared;
}

/** The host key's fingerprint as carried in invite links: SHA-256, base64url (43 chars). */
export function fingerprint(hostPublicKey: string): string {
  fromB64u(hostPublicKey, KEY_BYTES);
  return b64u(
    crypto.createHash("sha256").update(`${PROTOCOL} host\n${hostPublicKey}`, "utf8").digest()
  );
}

/** A short code people can read to each other to compare hosts: "K7QF-2M9D-XR4T". */
export function safetyCode(hostPublicKey: string): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I
  const bytes = crypto
    .createHash("sha256")
    .update(`${PROTOCOL} safety\n${hostPublicKey}`, "utf8")
    .digest();
  let out = "";
  for (let i = 0; i < 12; i++) out += alphabet[bytes[i] % alphabet.length];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

export const sameBytes = (a: string, b: string): boolean => {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ---------------------------------------------------------------- invites

/** What the host keeps for an invite: a lookup tag (sent by the client) and the PSK (never sent). */
export function inviteMaterial(inviteKey: string): { tag: string; psk: Buffer } {
  const mac = (label: string) =>
    crypto.createHmac("sha256", inviteKey).update(`${PROTOCOL} invite ${label}`).digest();
  return { tag: b64u(mac("tag").subarray(0, 16)), psk: mac("psk") };
}

// ---------------------------------------------------------------- handshake

export interface SessionKeys {
  sid: string;
  send: Buffer;
  recv: Buffer;
  /** Binds confirm messages to everything both sides saw. */
  transcript: Buffer;
}

export interface HandshakeInput {
  mode: HandshakeMode;
  /** pair: the invite tag; device: the device id. */
  tag: string;
  clientEphemeral: string;
  hostEphemeral: string;
  hostStatic: string;
  /** device mode only. */
  clientStatic?: string;
  sid: string;
}

function transcriptOf(t: HandshakeInput): Buffer {
  return crypto
    .createHash("sha256")
    .update(
      [
        PROTOCOL,
        t.mode,
        t.tag,
        t.sid,
        t.clientEphemeral,
        t.hostEphemeral,
        t.hostStatic,
        t.clientStatic ?? "",
      ].join("\n"),
      "utf8"
    )
    .digest();
}

function deriveKeys(ikm: Buffer, transcript: Buffer): { c2s: Buffer; s2c: Buffer } {
  const okm = Buffer.from(
    crypto.hkdfSync("sha256", ikm, transcript, `${PROTOCOL} keys`, KEY_BYTES * 2)
  );
  return { c2s: okm.subarray(0, KEY_BYTES), s2c: okm.subarray(KEY_BYTES) };
}

/** Host side. `hostEphemeralPrivate` / `hostStaticPrivate` never leave the host. */
export function hostKeys(
  t: HandshakeInput,
  hostStaticPrivate: string,
  hostEphemeralPrivate: string,
  psk?: Buffer
): SessionKeys {
  const parts = [
    dh(hostStaticPrivate, t.clientEphemeral),
    dh(hostEphemeralPrivate, t.clientEphemeral),
  ];
  if (t.mode === "device") {
    if (!t.clientStatic) throw new ChannelError("missing device key");
    parts.push(dh(hostStaticPrivate, t.clientStatic), dh(hostEphemeralPrivate, t.clientStatic));
  } else {
    if (!psk || psk.length !== KEY_BYTES) throw new ChannelError("missing invite");
    parts.push(psk);
  }
  const transcript = transcriptOf(t);
  const k = deriveKeys(Buffer.concat(parts), transcript);
  return { sid: t.sid, send: k.s2c, recv: k.c2s, transcript };
}

/** Client side. */
export function clientKeys(
  t: HandshakeInput,
  clientEphemeralPrivate: string,
  secret: { clientStaticPrivate: string } | { psk: Buffer }
): SessionKeys {
  const parts = [
    dh(clientEphemeralPrivate, t.hostStatic),
    dh(clientEphemeralPrivate, t.hostEphemeral),
  ];
  if (t.mode === "device") {
    if (!("clientStaticPrivate" in secret)) throw new ChannelError("missing device key");
    parts.push(
      dh(secret.clientStaticPrivate, t.hostStatic),
      dh(secret.clientStaticPrivate, t.hostEphemeral)
    );
  } else {
    if (!("psk" in secret)) throw new ChannelError("missing invite");
    parts.push(secret.psk);
  }
  const transcript = transcriptOf(t);
  const k = deriveKeys(Buffer.concat(parts), transcript);
  return { sid: t.sid, send: k.c2s, recv: k.s2c, transcript };
}

// ---------------------------------------------------------------- sealing

export type Direction = "c2s" | "s2c";

/** The largest counter either side will use (2^53 - 1, well under the 2^64 nonce space). */
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

function nonceOf(dir: Direction, n: number): Buffer {
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_COUNTER) throw new ChannelError("bad counter");
  const nonce = Buffer.alloc(NONCE_BYTES);
  nonce.writeUInt32BE(dir === "c2s" ? 1 : 2, 0);
  nonce.writeBigUInt64BE(BigInt(n), 4);
  return nonce;
}

const aadOf = (sid: string, dir: Direction, n: number, transcript: Buffer): Buffer =>
  Buffer.concat([Buffer.from(`${PROTOCOL}\n${sid}\n${dir}\n${n}\n`, "utf8"), transcript]);

export function seal(
  key: Buffer,
  sid: string,
  dir: Direction,
  n: number,
  transcript: Buffer,
  plaintext: string
): string {
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonceOf(dir, n));
  cipher.setAAD(aadOf(sid, dir, n, transcript));
  const body = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return b64u(body);
}

/** Throws {@link ChannelError} on any tampering, wrong key, wrong session or wrong direction. */
export function open(
  key: Buffer,
  sid: string,
  dir: Direction,
  n: number,
  transcript: Buffer,
  sealed: unknown
): string {
  const raw = fromB64u(sealed);
  if (raw.length < TAG_BYTES) throw new ChannelError("too short");
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonceOf(dir, n));
    decipher.setAAD(aadOf(sid, dir, n, transcript));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    return Buffer.concat([
      decipher.update(raw.subarray(0, raw.length - TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new ChannelError("could not decrypt");
  }
}

/** What the host's confirm message says; counter 0 is reserved for it. */
export const CONFIRM_TEXT = `${PROTOCOL} host-confirm`;
export const CONFIRM_COUNTER = 0;

// ---------------------------------------------------------------- replay protection

/**
 * Accepts each counter once. Counters may arrive out of order (a long poll and
 * a send in flight together), within {@link WINDOW} of the highest seen.
 */
export class ReplayWindow {
  static readonly WINDOW = 1024;
  private highest = 0;
  private readonly seen = new Set<number>();

  accept(n: number): boolean {
    if (!Number.isSafeInteger(n) || n < 1) return false;
    if (n + ReplayWindow.WINDOW <= this.highest) return false;
    if (this.seen.has(n)) return false;
    this.seen.add(n);
    if (n > this.highest) {
      this.highest = n;
      for (const old of this.seen) if (old + ReplayWindow.WINDOW <= n) this.seen.delete(old);
    }
    return true;
  }
}
