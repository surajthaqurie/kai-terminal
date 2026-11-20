import { describe, expect, it } from "vitest";
import { buildCommand, AgentError } from "../core/sharedAgent/agentRunner";
import {
  fromWireTokens,
  newParseState,
  parseClaude,
  parseOpencode,
  toWireTokens,
} from "../core/sharedAgent/events";
import {
  allowedOrigin,
  buildInviteLink,
  isPrivateIPv4,
  parseInviteLink,
  parsePublicUrl,
} from "../core/sharedAgent/invite";
import {
  classifyRequest,
  isTunnelled,
  localNetworks,
  networkFor,
  normalizeRemote,
  tunnelClientIp,
} from "../core/sharedAgent/netcheck";
import { GrantsError, defaultGrants, parseGrants } from "../core/sharedAgent/types";
import { formatCost, formatDuration } from "../components/sharedAgentViewModel";

describe("invite links", () => {
  const key = "A".repeat(43);

  it("parses a LAN invite and round-trips", () => {
    const link = buildInviteLink("http://192.168.1.20:8765", key);
    expect(parseInviteLink(link)).toEqual({
      origin: "http://192.168.1.20:8765",
      key,
      tunnel: false,
    });
    expect(parseInviteLink(`  ${link}  `)?.key).toBe(key);
  });

  it("defaults the port and accepts loopback", () => {
    expect(parseInviteLink(`http://10.0.0.5/join#${key}`)?.origin).toBe("http://10.0.0.5");
    expect(parseInviteLink(`http://127.0.0.1:9/join#${key}`)?.origin).toBe("http://127.0.0.1:9");
  });

  it.each([
    ["public address", `http://8.8.8.8:8765/join#${key}`],
    ["hostname over plain http", `http://example.com:8765/join#${key}`],
    ["https to an IP", `https://192.168.1.20:8765/join#${key}`],
    ["https to a public IP", `https://8.8.8.8/join#${key}`],
    ["https to localhost", `https://localhost/join#${key}`],
    ["https to a single-label name", `https://intranet/join#${key}`],
    ["https with credentials", `https://u:p@abc.tunnel.example.com/join#${key}`],
    ["https with a query", `https://abc.tunnel.example.com/join?x=1#${key}`],
    ["https wrong path", `https://abc.tunnel.example.com/x/join#${key}`],
    ["wrong path", `http://192.168.1.20:8765/other#${key}`],
    ["no secret", "http://192.168.1.20:8765/join"],
    ["short secret", "http://192.168.1.20:8765/join#abc"],
    ["bad characters", "http://192.168.1.20:8765/join#abc def ghi jkl"],
    ["credentials", `http://u:p@192.168.1.20:8765/join#${key}`],
    ["link-local", `http://169.254.1.1:8765/join#${key}`],
    ["not a url", "hello"],
    ["empty", ""],
  ])("rejects %s", (_name, link) => {
    expect(parseInviteLink(link)).toBeNull();
  });

  it("knows private ranges", () => {
    for (const ip of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1", "127.0.0.1"]) {
      expect(isPrivateIPv4(ip), ip).toBe(true);
    }
    for (const ip of ["172.15.0.1", "172.32.0.1", "11.0.0.1", "8.8.8.8", "999.1.1.1", "1.2.3"]) {
      expect(isPrivateIPv4(ip), ip).toBe(false);
    }
  });
});

describe("internet (tunnel) links", () => {
  const key = "A".repeat(43);

  it("parses an https tunnel invite", () => {
    const link = buildInviteLink("https://abc-12.tunnel.example.com", key);
    expect(link).toBe(`https://abc-12.tunnel.example.com/join#${key}`);
    expect(parseInviteLink(link)).toEqual({
      origin: "https://abc-12.tunnel.example.com",
      key,
      tunnel: true,
    });
    expect(parseInviteLink(`https://x.trycloudflare.com:8443/join#${key}`)?.origin).toBe(
      "https://x.trycloudflare.com:8443"
    );
  });

  it("validates a pasted tunnel address", () => {
    expect(parsePublicUrl(" https://abc.tunnel.example.com/ ")).toBe(
      "https://abc.tunnel.example.com"
    );
    expect(parsePublicUrl("https://ABC.tunnel.example.com")).toBe("https://abc.tunnel.example.com");
    for (const bad of [
      "http://abc.tunnel.example.com",
      "https://abc.tunnel.example.com/path",
      "https://abc.tunnel.example.com/?q=1",
      "https://192.168.1.20",
      "https://localhost",
      "https://printer.local",
      "abc.tunnel.example.com",
      "",
    ]) {
      expect(parsePublicUrl(bad), bad).toBeNull();
    }
  });

  it("only allows http to private IPs and https to public names", () => {
    expect(allowedOrigin("http://192.168.1.20:8765")).toEqual({
      origin: "http://192.168.1.20:8765",
      tunnel: false,
    });
    expect(allowedOrigin("https://abc.tunnel.example.com")?.tunnel).toBe(true);
    expect(allowedOrigin("http://abc.tunnel.example.com")).toBeNull();
    expect(allowedOrigin("http://8.8.8.8")).toBeNull();
    expect(allowedOrigin("file:///etc/passwd")).toBeNull();
  });
});

describe("tunnel detection on the host", () => {
  const nets = [
    { address: "192.168.1.20", cidr: "192.168.1.0/24", base: 0xc0a80100, mask: 0xffffff00 },
  ];

  it("spots relayed requests by standard forwarding headers or the tunnel's host name", () => {
    expect(isTunnelled({ host: "127.0.0.1:8765" })).toBe(false);
    expect(isTunnelled({ host: "192.168.1.20:8765" })).toBe(false);
    for (const h of ["x-forwarded-for", "forwarded", "x-forwarded-host", "x-real-ip", "via"]) {
      expect(isTunnelled({ host: "127.0.0.1:8765", [h]: "x" }), h).toBe(true);
    }
    expect(isTunnelled({ host: "Share.Example.com" }, "share.example.com")).toBe(true);
    expect(isTunnelled({ host: "share.example.com:443" }, "share.example.com")).toBe(true);
    expect(isTunnelled({ host: "other.example.com" }, "share.example.com")).toBe(false);
  });

  it("never trusts a relayed request as local or LAN, wherever the tunnel agent runs", () => {
    const fwd = { host: "share.example.com", "x-forwarded-for": "1.2.3.4" };
    expect(classifyRequest("127.0.0.1", { host: "127.0.0.1:1" }, nets)).toBe("loopback");
    expect(classifyRequest("192.168.1.55", { host: "192.168.1.20:1" }, nets)).toBe(
      "192.168.1.0/24"
    );
    // Agent on this PC, in a container on a local subnet, or on another LAN machine.
    expect(classifyRequest("::ffff:127.0.0.1", fwd, nets)).toBe("tunnel");
    expect(classifyRequest("192.168.1.99", fwd, nets)).toBe("tunnel");
    // A raw TCP tunnel adds no headers: caught by the host name, or a foreign name on loopback.
    expect(
      classifyRequest("192.168.1.99", { host: "share.example.com" }, nets, "share.example.com")
    ).toBe("tunnel");
    expect(classifyRequest("127.0.0.1", { host: "relay.example.net:4000" }, nets)).toBe("tunnel");
    // Off-LAN callers stay refused, headers or not.
    expect(classifyRequest("8.8.8.8", fwd, nets)).toBeNull();
  });

  it("takes the client address the nearest proxy appended", () => {
    expect(tunnelClientIp({ "x-forwarded-for": "6.6.6.6, 1.2.3.4" })).toBe("1.2.3.4");
    expect(tunnelClientIp({ forwarded: 'for=6.6.6.6, for="[2001:db8::1]:443"' })).toBe(
      "2001:db8::1"
    );
    expect(tunnelClientIp({ "x-real-ip": "5.5.5.5" })).toBe("5.5.5.5");
    expect(tunnelClientIp({})).toBe("internet");
  });
});

describe("same-network check", () => {
  const ifaces = {
    Ethernet: [
      {
        address: "192.168.1.20",
        netmask: "255.255.255.0",
        family: "IPv4" as const,
        mac: "",
        internal: false,
        cidr: null,
      },
    ],
    Loop: [
      {
        address: "127.0.0.1",
        netmask: "255.0.0.0",
        family: "IPv4" as const,
        mac: "",
        internal: true,
        cidr: null,
      },
    ],
    Public: [
      {
        address: "8.8.4.4",
        netmask: "255.255.255.0",
        family: "IPv4" as const,
        mac: "",
        internal: false,
        cidr: null,
      },
    ],
  };
  const nets = localNetworks(ifaces);

  it("keeps only private, non-loopback subnets", () => {
    expect(nets.map((n) => n.cidr)).toEqual(["192.168.1.0/24"]);
  });

  it("classifies callers", () => {
    expect(networkFor("192.168.1.55", nets)).toBe("192.168.1.0/24");
    expect(networkFor("::ffff:192.168.1.55", nets)).toBe("192.168.1.0/24");
    expect(networkFor("127.0.0.1", nets)).toBe("loopback");
    expect(networkFor("::1", nets)).toBe("loopback");
    expect(networkFor("192.168.2.9", nets)).toBeNull(); // private, but another subnet
    expect(networkFor("8.8.8.8", nets)).toBeNull();
    expect(networkFor(undefined, nets)).toBeNull();
    expect(normalizeRemote("::ffff:10.0.0.1")).toBe("10.0.0.1");
  });
});

describe("agent command lines", () => {
  it("builds a read-only, non-interactive Claude command", () => {
    const { args } = buildCommand("claude");
    expect(args).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json"]));
    expect(args).toEqual(expect.arrayContaining(["--permission-mode", "dontAsk", "--restricted"]));
    expect(args).toEqual(expect.arrayContaining(["--allowedTools", "Read", "Glob", "Grep"]));
    expect(args).toContain("--strict-mcp-config");
    // The answer streams as it is written.
    expect(args).toContain("--include-partial-messages");
    // Nothing that could write, run commands or skip permissions.
    for (const bad of ["Bash", "Edit", "Write", "bypassPermissions", "acceptEdits"]) {
      expect(args, bad).not.toContain(bad);
    }
  });

  it("adds a validated model and session, and refuses anything else", () => {
    const sid = "11111111-1111-1111-1111-111111111111";
    const { args } = buildCommand("claude", { model: "sonnet", resume: sid });
    expect(args).toEqual(expect.arrayContaining(["--model", "sonnet", "--resume", sid]));
    expect(() => buildCommand("claude", { model: "x; rm -rf /" })).toThrow(AgentError);
    expect(() => buildCommand("claude", { resume: "--dangerously-skip-permissions" })).toThrow(
      AgentError
    );
    expect(() => buildCommand("opencode", { resume: sid })).toThrow(AgentError);
  });

  it("denies every write and shell tool for OpenCode", () => {
    const { args, env } = buildCommand("opencode", { resume: "ses_abcdef123456" });
    expect(args).toEqual(
      expect.arrayContaining(["--agent", "plan", "--session", "ses_abcdef123456"])
    );
    const deny = JSON.parse(env.OPENCODE_CONFIG_CONTENT).permission;
    for (const tool of ["edit", "write", "bash", "execute", "webfetch"]) {
      expect(deny[tool], tool).toBe("deny");
    }
  });
});

describe("agent output parsing", () => {
  it("turns Claude stream-json into display events and counts tokens", () => {
    const st = newParseState();
    const lines = [
      { type: "system", subtype: "init", session_id: "s-1", model: "sonnet" },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Looking." },
            { type: "tool_use", name: "Read", input: { file_path: "a.ts" } },
          ],
        },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }] },
      },
      {
        type: "result",
        subtype: "success",
        total_cost_usd: 0.5,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 1,
        },
      },
    ];
    const events = lines.flatMap((l) => parseClaude(l, st));
    expect(events.map((e) => e.type)).toEqual(["session", "text", "tool", "tool_result"]);
    expect(events[2]).toMatchObject({ name: "Read", detail: "a.ts" });
    expect(st).toMatchObject({ sessionId: "s-1", ok: true, costUsd: 0.5 });
    expect(st.tokens).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1 });
  });

  it("hides a denied tool's result and reports a failed run", () => {
    const st = newParseState();
    parseClaude(
      { type: "system", subtype: "permission_denied", tool_use_id: "t9", tool_name: "Bash" },
      st
    );
    const hidden = parseClaude(
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t9", content: "x" }] },
      },
      st
    );
    expect(hidden).toEqual([]);
    parseClaude(
      { type: "result", subtype: "error_max_turns", is_error: true, result: "too long" },
      st
    );
    expect(st.ok).toBe(false);
    expect(st.error).toBe("too long");
  });

  it("turns partial text into deltas, and ignores other partial events", () => {
    const st = newParseState();
    const delta = (d: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: d },
      ...extra,
    });
    expect(parseClaude(delta({ type: "text_delta", text: "Hel" }), st)).toEqual([
      { type: "delta", text: "Hel" },
    ]);
    expect(parseClaude(delta({ type: "input_json_delta", partial_json: "{" }), st)).toEqual([]);
    expect(parseClaude(delta({ type: "text_delta", text: "" }), st)).toEqual([]);
    expect(parseClaude({ type: "stream_event", event: { type: "message_start" } }, st)).toEqual([]);
    // A sub-agent's partial text stays hidden like the rest of its steps.
    expect(
      parseClaude(delta({ type: "text_delta", text: "x" }, { parent_tool_use_id: "p" }), st)
    ).toEqual([]);
  });

  it("ignores sub-agent chatter and malformed blocks", () => {
    const st = newParseState();
    expect(parseClaude({ type: "assistant", parent_tool_use_id: "p", message: {} }, st)).toEqual(
      []
    );
    expect(parseClaude({ type: "assistant", message: { content: "nope" } }, st)).toEqual([]);
    expect(parseClaude({ type: "weird" }, st)).toEqual([]);
  });

  it("parses OpenCode text, tools and step totals (reasoning counts as output)", () => {
    const st = newParseState();
    const events = [
      { sessionID: "ses_abc123456", type: "text", part: { text: "Hi" } },
      {
        type: "tool_use",
        part: { tool: "read", state: { status: "completed", input: { path: "x" }, output: "ok" } },
      },
      {
        type: "step_finish",
        part: {
          cost: 0.2,
          tokens: { input: 7, output: 3, reasoning: 2, cache: { read: 4, write: 1 } },
        },
      },
    ].flatMap((l) => parseOpencode(l, st));
    expect(events.map((e) => e.type)).toEqual(["session", "text", "tool", "tool_result"]);
    expect(st.tokens).toEqual({ input: 7, output: 5, cacheRead: 4, cacheWrite: 1 });
    expect(st.costUsd).toBeCloseTo(0.2);
  });

  it("converts token totals to and from the wire spelling", () => {
    const wire = toWireTokens({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
    expect(wire).toEqual({ input: 1, output: 2, cache_read: 3, cache_write: 4 });
    expect(fromWireTokens(wire)).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
    expect(fromWireTokens(undefined)).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(fromWireTokens({ input: -5, output: "x" }).input).toBe(0);
  });
});

describe("per-PC permissions (parseGrants)", () => {
  it("fills what is missing with the defaults", () => {
    expect(parseGrants({})).toEqual(defaultGrants());
    expect(parseGrants({ agents: { opencode: false } })).toEqual({
      ...defaultGrants(),
      agents: { claude: true, opencode: false },
    });
  });

  it("trims models and drops empty ones", () => {
    expect(
      parseGrants({ models: { claude: "  claude-sonnet-4  ", opencode: "  " }, maxMinutes: 240 })
    ).toEqual({ ...defaultGrants(), models: { claude: "claude-sonnet-4" }, maxMinutes: 240 });
    expect(parseGrants({ models: { claude: null } }).models).toEqual({});
  });

  it.each<[string, unknown]>([
    ["not an object", "x"],
    ["an array", []],
    ["an unknown agent", { agents: { evil: true } }],
    ["a non-boolean switch", { agents: { claude: "yes" } }],
    ["a model for an unknown agent", { models: { evil: "m" } }],
    ["a model with a space", { models: { claude: "a b" } }],
    ["a model with a quote", { models: { claude: 'a"b' } }],
    ["a model that is too long", { models: { claude: "m".repeat(101) } }],
    ["a non-string model", { models: { claude: 5 } }],
    ["zero minutes", { maxMinutes: 0 }],
    ["too many minutes", { maxMinutes: 241 }],
    ["fractional minutes", { maxMinutes: 1.5 }],
    ["minutes as text", { maxMinutes: "10" }],
    ["NaN minutes", { maxMinutes: Number.NaN }],
  ])("refuses %s", (_name, value) => {
    expect(() => parseGrants(value)).toThrow(GrantsError);
  });
});

describe("usage formatting", () => {
  it("formats cost and duration", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.004)).toBe("<$0.01");
    expect(formatCost(1.234)).toBe("$1.23");
    expect(formatDuration(7.25)).toBe("7s");
    expect(formatDuration(125)).toBe("2m 05s");
  });
});

describe("detectOtherClis", () => {
  it("only lists registry CLIs that are not shareable, never IDE agents or shared ones", async () => {
    const { detectOtherClis } = await import("../core/sharedAgent/agentRunner");
    const { AGENT_REGISTRY } = await import("../core/agents");
    const { isSharedAgentId } = await import("../core/sharedAgent/types");
    for (const row of detectOtherClis()) {
      const def = AGENT_REGISTRY.find((d) => d.id === row.id);
      expect(def?.kind).toBe("cli");
      expect(isSharedAgentId(row.id)).toBe(false);
      expect(row.reason.length).toBeGreaterThan(0);
    }
  });
});
