import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import {
  atomicWriteJson,
  computeProjectId,
  getKaiHomeDir,
  getProjectStorageDir,
  resolveCanonicalPath,
} from "../registry";
import { IntegrationError, type IntegrationAccount, type ProjectBinding } from "./types";

/**
 * Two stores, kept apart on purpose:
 * - Accounts are global: `~/.kai/config.json` under `integrations.accounts`.
 *   Secrets are NOT here (see secretStore.ts).
 * - A project's binding is one private file in that project's Kai storage
 *   (`~/.kai/projects/<id>/integration.json`). Nothing is written into the
 *   repository, so a cloned repo can never switch an integration on, or grant
 *   itself access to an organization.
 */
const BINDING_FILE = "integration.json";
const BINDING_VERSION = 1;

function configPath(): string {
  return path.join(getKaiHomeDir(), "config.json");
}

/** The raw config object. Throws on corrupt JSON rather than overwrite what the user wrote. */
function readConfigFile(): Record<string, unknown> {
  const file = configPath();
  if (!fs.existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new IntegrationError(
      "config",
      `Cannot read ${file}: it is not valid JSON.`,
      "Fix or remove the file, then retry."
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new IntegrationError("config", `${file} must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function accountsFrom(config: Record<string, unknown>): Record<string, IntegrationAccount> {
  const block = config.integrations;
  if (typeof block !== "object" || block === null) return {};
  const accounts = (block as { accounts?: unknown }).accounts;
  if (typeof accounts !== "object" || accounts === null || Array.isArray(accounts)) return {};
  const out: Record<string, IntegrationAccount> = {};
  for (const [id, raw] of Object.entries(accounts)) {
    if (isAccount(raw) && raw.id === id) out[id] = raw;
  }
  return out;
}

function isAccount(v: unknown): v is IntegrationAccount {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.id === "string" &&
    typeof a.provider === "string" &&
    typeof a.org === "string" &&
    typeof a.baseUrl === "string" &&
    (a.authMethod === "az" || a.authMethod === "pat")
  );
}

export function listAccounts(provider?: string): IntegrationAccount[] {
  const all = Object.values(accountsFrom(readConfigFile()));
  return provider ? all.filter((a) => a.provider === provider) : all;
}

export function getAccount(id: string): IntegrationAccount | null {
  return accountsFrom(readConfigFile())[id] ?? null;
}

export function saveAccount(account: IntegrationAccount): void {
  const config = readConfigFile();
  const block = (
    typeof config.integrations === "object" && config.integrations !== null
      ? config.integrations
      : {}
  ) as Record<string, unknown>;
  const accounts = { ...accountsFrom(config), [account.id]: account };
  atomicWriteJson(configPath(), { ...config, integrations: { ...block, accounts } });
}

export function removeAccount(id: string): boolean {
  const config = readConfigFile();
  const accounts = accountsFrom(config);
  if (!(id in accounts)) return false;
  delete accounts[id];
  const block = config.integrations as Record<string, unknown>;
  atomicWriteJson(configPath(), { ...config, integrations: { ...block, accounts } });
  return true;
}

// ---------------------------------------------------------------------------
// Project binding
// ---------------------------------------------------------------------------

/**
 * `resolveCanonicalPath`, plus the long spelling of a Windows 8.3 short path
 * (`C:\Users\RUNNER~1\...`). Git reports the long spelling, and the binding's
 * storage id is a hash of the path, so the two spellings of one folder would
 * otherwise get different ids and a binding written under one is never found
 * from the other.
 */
function canonicalLongPath(target: string): string {
  const canonical = resolveCanonicalPath(target);
  try {
    return fs.realpathSync.native(canonical);
  } catch {
    return canonical;
  }
}

/** The git top-level of `dir`, or `dir` itself when it is not inside a repository. */
export function projectRootFor(dir: string): string {
  const canonical = canonicalLongPath(dir);
  try {
    const top = execFileSync("git", ["-C", canonical, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      windowsHide: true,
    }).trim();
    if (top) return canonicalLongPath(top);
  } catch {
    // not a repository, or git is missing
  }
  return canonical;
}

function bindingPath(root: string): string {
  return path.join(getProjectStorageDir(computeProjectId(root)), BINDING_FILE);
}

function parseBinding(raw: string): ProjectBinding | null {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof v.provider === "string" &&
      typeof v.account === "string" &&
      typeof v.project === "string" &&
      (v.repo === null || typeof v.repo === "string")
    ) {
      return {
        provider: v.provider,
        account: v.account,
        project: v.project,
        repo: v.repo as string | null,
        boundAt: typeof v.boundAt === "string" ? v.boundAt : "",
      };
    }
  } catch {
    // unreadable binding is treated as no binding
  }
  return null;
}

/** Candidate project roots for `dir`: itself, then each parent up to the git top-level. */
function ancestorsUpTo(dir: string, stopAt: string): string[] {
  const out: string[] = [];
  let current = canonicalLongPath(dir);
  for (let i = 0; i < 40; i++) {
    out.push(current);
    if (current === stopAt) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}

/**
 * The binding that applies to `dir`, and the root it is stored under. An agent
 * started in a sub-folder of a bound repository still finds the repository's
 * binding; the nearest one wins.
 */
export function findBinding(dir: string): { root: string; binding: ProjectBinding } | null {
  const top = projectRootFor(dir);
  for (const root of ancestorsUpTo(dir, top)) {
    const file = bindingPath(root);
    if (!fs.existsSync(file)) continue;
    const binding = parseBinding(fs.readFileSync(file, "utf8"));
    if (binding) return { root, binding };
  }
  return null;
}

export function writeBinding(root: string, binding: ProjectBinding): void {
  // `root` is only a label for listings: it lets `kai remove --name` name the folder, not its hash.
  atomicWriteJson(bindingPath(root), { version: BINDING_VERSION, root, ...binding });
}

export function removeBinding(root: string): boolean {
  const file = bindingPath(root);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

interface BoundProject {
  /** `<projects dir>/<id>/integration.json` */
  file: string;
  /** The project's path when Kai knows it, else its storage id. */
  label: string;
}

/** Every project currently bound to `accountId` (best effort; scans Kai's project storage). */
function boundProjects(accountId: string): BoundProject[] {
  const projectsDir = path.join(getKaiHomeDir(), "projects");
  let entries: string[];
  try {
    entries = fs.readdirSync(projectsDir);
  } catch {
    return [];
  }
  const out: BoundProject[] = [];
  for (const id of entries) {
    const file = path.join(projectsDir, id, BINDING_FILE);
    let binding: ProjectBinding | null = null;
    let label = `project ${id}`;
    try {
      const raw = fs.readFileSync(file, "utf8");
      binding = parseBinding(raw);
      const root = (JSON.parse(raw) as { root?: unknown }).root;
      if (typeof root === "string" && root) label = root;
    } catch {
      continue;
    }
    if (binding?.account !== accountId) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(projectsDir, id, "meta.json"), "utf8")) as {
        canonicalPath?: string;
        rootPath?: string;
      };
      label = meta.canonicalPath ?? meta.rootPath ?? label;
    } catch {
      // a bound project that was never indexed has no metadata
    }
    out.push({ file, label });
  }
  return out;
}

/** Roots of every project currently bound to `accountId`. */
export function projectsUsingAccount(accountId: string): string[] {
  return boundProjects(accountId).map((p) => p.label);
}

/** Delete every project's binding to `accountId`; returns how many were removed. */
export function removeBindingsForAccount(accountId: string): number {
  let removed = 0;
  for (const { file } of boundProjects(accountId)) {
    try {
      fs.rmSync(file, { force: true });
      removed++;
    } catch {
      // a binding that cannot be deleted stays and reports `account_missing`
    }
  }
  return removed;
}
