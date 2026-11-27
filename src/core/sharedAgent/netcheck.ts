/**
 * Same-network check for the host server.
 *
 * A PC may pair with, and use, the host only from an address inside a subnet
 * this PC is directly attached to (or from this PC itself). The subnet a PC
 * paired from is remembered, and a request from another subnet is refused, so a
 * stolen token stops working off the LAN. Limit: this keeps the internet out,
 * but a machine already on the LAN can claim any LAN address, so the device
 * token is what really identifies a PC.
 */
import os from "os";
import { isPrivateIPv4, parseIPv4 } from "./invite";

export interface LocalNetwork {
  /** This PC's address on the subnet. */
  address: string;
  /** e.g. "192.168.1.0/24". */
  cidr: string;
  base: number;
  mask: number;
  /** The adapter's name as the OS reports it, e.g. "Wi-Fi" or "vEthernet (WSL)". */
  adapter?: string;
  /**
   * True for a virtual adapter (WSL, Hyper-V, Docker, VirtualBox, VMware…).
   * Its address lives on a private network inside this PC, so other PCs
   * usually can't reach it.
   */
  virtual?: boolean;
}

/** Adapter names of virtual switches and VMs: reachable from this PC only. */
const VIRTUAL_ADAPTER_RE =
  /vethernet|\bwsl\b|hyper-?v|virtualbox|vboxnet|vmware|^vmnet|docker|^veth|^virbr|^br-|^cni|flannel|podman|default switch|loopback|npcap/i;

/** True when an adapter name looks like a virtual switch rather than a real network card. */
export function isVirtualAdapter(name: string): boolean {
  return VIRTUAL_ADAPTER_RE.test(name);
}

const toInt = (ip: [number, number, number, number]): number =>
  ((ip[0] << 24) | (ip[1] << 16) | (ip[2] << 8) | ip[3]) >>> 0;

function prefixOf(netmask: string): number | null {
  const m = parseIPv4(netmask);
  if (!m) return null;
  const bits = toInt(m).toString(2).padStart(32, "0");
  if (!/^1*0*$/.test(bits)) return null; // not a contiguous mask
  const firstZero = bits.indexOf("0");
  return firstZero === -1 ? 32 : firstZero;
}

/** Every private IPv4 subnet this PC is attached to. */
export function localNetworks(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()
): LocalNetwork[] {
  const out: LocalNetwork[] = [];
  for (const [adapter, list] of Object.entries(interfaces)) {
    for (const info of list ?? []) {
      if (info.family !== "IPv4" || info.internal) continue;
      const ip = parseIPv4(info.address);
      const prefix = prefixOf(info.netmask);
      if (!ip || prefix === null || prefix < 8 || !isPrivateIPv4(info.address)) continue;
      const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
      const base = (toInt(ip) & mask) >>> 0;
      const cidr = `${[24, 16, 8, 0].map((s) => (base >>> s) & 255).join(".")}/${prefix}`;
      if (!out.some((n) => n.cidr === cidr)) {
        out.push({
          address: info.address,
          cidr,
          base,
          mask,
          adapter,
          virtual: isVirtualAdapter(adapter),
        });
      }
    }
  }
  return out;
}

/**
 * This PC's LAN addresses, real network cards first, so an invite link names an
 * address other PCs can reach rather than a WSL or Hyper-V switch.
 */
export function lanAddresses(networks: LocalNetwork[] = localNetworks()): string[] {
  return rankedNetworks(networks).map((n) => n.address);
}

/** The networks with real adapters first (order otherwise kept). */
export function rankedNetworks(networks: LocalNetwork[] = localNetworks()): LocalNetwork[] {
  return [...networks.filter((n) => !n.virtual), ...networks.filter((n) => n.virtual)];
}

/** Strips the IPv4-mapped IPv6 prefix Node reports for IPv4 clients. */
export function normalizeRemote(remote: string | undefined): string {
  return (remote ?? "").replace(/^::ffff:/i, "");
}

/** The network label for PCs that came in through an internet tunnel. */
export const TUNNEL_NETWORK = "tunnel";

type Headers = Record<string, string | string[] | undefined>;

/** Standard headers a reverse proxy or tunnel adds; a PC talking to us directly sends none. */
const FORWARD_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "via",
];

const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : v) ?? "";

/** The host part of a Host header, lower-case, without port or IPv6 brackets. */
function hostOf(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/^\[(.*)\]$/, "$1");
}

const isLoopbackName = (h: string): boolean =>
  h === "" || h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);

/**
 * True when a request was relayed by a tunnel or reverse proxy rather than
 * sent straight from a PC: it carries forwarding headers, or it is addressed
 * to the tunnel's public host name. Works for any tunnel, wherever its agent
 * runs (this PC, a container, another machine on the LAN). Forging these
 * headers can only make a request look *less* trusted, never more.
 */
export function isTunnelled(headers: Headers, publicHost: string | null = null): boolean {
  if (FORWARD_HEADERS.some((h) => first(headers[h]))) return true;
  const host = hostOf(first(headers.host));
  return publicHost !== null && host === publicHost.toLowerCase();
}

/**
 * The internet client's address, for rate limiting and display only: the
 * right-most X-Forwarded-For entry or `Forwarded: for=` value (the one the
 * nearest proxy appended; earlier entries are whatever the caller sent).
 */
export function tunnelClientIp(headers: Headers): string {
  const xff = first(headers["x-forwarded-for"])
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const fwd = [...first(headers.forwarded).matchAll(/for="?\[?([^\]";,\s]+)/gi)].map((m) => m[1]);
  const ip = xff[xff.length - 1] ?? fwd[fwd.length - 1] ?? first(headers["x-real-ip"]).trim();
  return (ip || "internet").slice(0, 64);
}

/**
 * Like {@link networkFor}, but aware of tunnels: a relayed request is
 * {@link TUNNEL_NETWORK}, never "loopback" or a LAN subnet. A loopback
 * connection addressed to any name other than this machine is treated as
 * relayed too (a raw TCP tunnel adds no headers).
 */
export function classifyRequest(
  remote: string | undefined,
  headers: Headers,
  networks: LocalNetwork[] = localNetworks(),
  publicHost: string | null = null
): string | null {
  const net = networkFor(remote, networks);
  if (net === null) return null;
  if (isTunnelled(headers, publicHost)) return TUNNEL_NETWORK;
  if (net === "loopback" && !isLoopbackName(hostOf(first(headers.host)))) return TUNNEL_NETWORK;
  return net;
}

/** "loopback", the subnet the address belongs to, or null (not on this LAN). */
export function networkFor(
  remote: string | undefined,
  networks: LocalNetwork[] = localNetworks()
): string | null {
  const addr = normalizeRemote(remote);
  if (addr === "::1") return "loopback";
  const ip = parseIPv4(addr);
  if (!ip) return null;
  if (ip[0] === 127) return "loopback";
  if (!isPrivateIPv4(addr)) return null;
  const n = toInt(ip);
  return networks.find((net) => (n & net.mask) >>> 0 === net.base)?.cidr ?? null;
}
