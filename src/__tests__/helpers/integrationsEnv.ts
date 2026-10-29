import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { createAzureDevOpsProvider } from "../../core/integrations/providers/azure-devops";
import type { SecretLocation, SecretStore } from "../../core/integrations/secretStore";
import {
  IntegrationError,
  type IntegrationAccount,
  type IntegrationProvider,
} from "../../core/integrations/types";

/** A throwaway `~/.kai`. Call `restore()` in afterEach. */
export function useTempKaiHome(): { home: string; restore: () => void } {
  const saved = process.env.KAI_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kai-integrations-"));
  process.env.KAI_HOME = home;
  return {
    home,
    restore: () => {
      if (saved === undefined) delete process.env.KAI_HOME;
      else process.env.KAI_HOME = saved;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

/** A temp git repository, optionally with an `origin` remote. */
export function makeRepo(remote?: string): { dir: string; cleanup: () => void } {
  // `.native` also expands a Windows 8.3 short temp path, which is the spelling git reports.
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "kai-repo-")));
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  if (remote)
    execFileSync("git", ["-C", dir, "remote", "add", "origin", remote], { stdio: "ignore" });
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export class MemorySecrets implements SecretStore {
  readonly data = new Map<string, string>();
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async has(key: string) {
    return this.data.has(key);
  }
  async set(key: string, value: string): Promise<SecretLocation> {
    this.data.set(key, value);
    return "os";
  }
  async delete(key: string) {
    this.data.delete(key);
  }
}

/** Projects and repositories a fake account can reach (no network). */
export const FAKE_REPOS: Record<string, string[]> = {
  "My Project": ["api", "web"],
  Payments: ["api", "ledger"],
  Platform: ["infra"],
  Mobile: [],
};

export const fakeDiscovery: NonNullable<IntegrationProvider["discovery"]> = {
  async listProjects() {
    return Object.keys(FAKE_REPOS)
      .sort()
      .map((name) => ({ name }));
  },
  async listRepos(_account, _secrets, project) {
    const repos = FAKE_REPOS[project];
    if (!repos) throw new IntegrationError("not_found", `No project ${project}.`);
    return repos.map((name) => ({ name }));
  },
};

export function azAccount(org = "contoso", authMethod: "az" | "pat" = "pat"): IntegrationAccount {
  return {
    id: `azure-devops:${org.toLowerCase()}`,
    provider: "azure-devops",
    org,
    baseUrl: `https://dev.azure.com/${org}`,
    authMethod,
    apiVersion: "7.1",
    createdAt: "2026-10-29T00:00:00.000Z",
  };
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface FakeRoute {
  /** Substring of `METHOD url` the route answers. The first matching route wins. */
  match: string;
  status?: number;
  body?: unknown;
  /** Raw text body (takes precedence over `body`). */
  text?: string;
  headers?: Record<string, string>;
}

/** A `fetch` that answers from a route table and records every call. */
export function fakeFetch(routes: FakeRoute[]): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({
      url,
      method,
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const route = routes.find((r) => `${method} ${decodeURIComponent(url)}`.includes(r.match));
    if (!route)
      return new Response(JSON.stringify({ message: `no route for ${method} ${url}` }), {
        status: 404,
      });
    const text = route.text ?? JSON.stringify(route.body ?? {});
    return new Response(text, {
      status: route.status ?? 200,
      headers: {
        "content-type": route.text !== undefined ? "text/plain" : "application/json",
        ...route.headers,
      },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** The real Azure provider with every network call replaced by a harmless stub. */
export function offlineAzure(over: Partial<IntegrationProvider> = {}): IntegrationProvider {
  const real = createAzureDevOpsProvider();
  const emptyPage = async () => ({ items: [], hasMore: false });
  const unused = async () => {
    throw new Error("not used in this test");
  };
  return {
    ...real,
    discovery: fakeDiscovery,
    async verify() {
      return { name: "Test User", email: "test@contoso.com" };
    },
    workItems: { search: emptyPage, get: unused },
    pullRequests: { list: emptyPage, get: unused },
    builds: { list: emptyPage, log: unused },
    ...over,
  };
}

/**
 * A sandbox for agent wiring: a temp home, and a PATH that finds a fake
 * `claude`. Wiring a real agent's config from a test would be a disaster, so
 * every test that wires goes through this. Call `restore()` in afterEach.
 */
export function useFakeAgents(installed: string[] = ["claude"]): {
  home: string;
  restore: () => void;
} {
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    PATH: process.env.PATH,
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kai-agent-home-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  for (const name of installed) fs.writeFileSync(path.join(bin, name), "");
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ""}`;
  return {
    home,
    restore: () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}
