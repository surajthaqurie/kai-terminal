import fs from "fs";
import path from "path";
import { listProjects, listRepos } from "../../core/integrations/service";
import {
  IntegrationError,
  asIntegrationError,
  type IntegrationAccount,
  type ProjectBinding,
} from "../../core/integrations/types";
import { ask, confirm, isInteractive } from "../prompt";

/** Helpers shared by `kai integration …` and `kai azure …`. */
export interface Flags {
  bool: Set<string>;
  value: Map<string, string>;
  positional: string[];
}

const VALUE_FLAGS = new Set(["--org", "--project", "--repo", "--server-url", "--name"]);

export function parseFlags(args: string[]): Flags {
  const out: Flags = { bool: new Set(), value: new Map(), positional: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (VALUE_FLAGS.has(arg)) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out.value.set(arg, next);
        i++;
      } else {
        out.value.set(arg, "");
      }
    } else if (arg.startsWith("--")) {
      out.bool.add(arg);
    } else if (arg === "-y") {
      out.bool.add("--yes");
    } else {
      out.positional.push(arg);
    }
  }
  return out;
}

/** Reject options the command does not know, so a typo is an error and not a silent no-op. */
export function assertKnownFlags(flags: Flags, allowed: readonly string[]): void {
  const known = new Set(allowed);
  const unknown = [...flags.bool, ...flags.value.keys()].filter((f) => !known.has(f));
  if (unknown.length > 0) {
    throw new IntegrationError(
      "bad_request",
      `Unknown option ${unknown.join(", ")}.`,
      `Allowed here: ${allowed.join(" ")}`
    );
  }
}

/** The single value of a flag that may be spelled two ways (`--name` / `--project`). */
export function flagValue(flags: Flags, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = flags.value.get(n);
    if (v) return v;
  }
  return undefined;
}

export function fail(err: unknown): number {
  const e = err instanceof IntegrationError ? err : asIntegrationError(err);
  console.error(`[kai] Error: ${e.message}`);
  if (e.hint) console.error(`  ${e.hint}`);
  return 1;
}

export function projectDirFrom(flags: Flags): string {
  const dir = path.resolve(flags.positional[0] ?? process.cwd());
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new IntegrationError("bad_request", `Not a directory: ${dir}`);
  }
  return dir;
}

export const authLabel = (method: string): string =>
  method === "oauth" ? "browser sign-in" : method === "az" ? "Azure CLI" : "access token";

/** `Payments / api`, or just the project when there is no repository. */
export const where = (b: Pick<ProjectBinding, "project" | "repo">): string =>
  b.repo ? `${b.project} / ${b.repo}` : b.project;

/** A choice typed as a 1-based number or as a name, resolved against `names`. */
export function pickFrom(typed: string, names: readonly string[]): string {
  const t = typed.trim();
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    if (n >= 1 && n <= names.length) return names[n - 1];
  }
  return t;
}

/** Runs `attempt`, asking before replacing a different integration already bound here. */
export async function withReplace<T>(
  yes: boolean,
  attempt: (replace: boolean) => Promise<T>
): Promise<T | null> {
  try {
    return await attempt(false);
  } catch (err) {
    if (!(err instanceof IntegrationError) || err.code !== "needs_confirmation") throw err;
    if (!yes && !(isInteractive() && (await confirm(`${err.message} Replace it?`)))) {
      console.error(`[kai] ${err.message} Only one integration is active per project.`);
      console.error(`  Re-run with --yes to replace it.`);
      return null;
    }
    return attempt(true);
  }
}

export interface Picked {
  project: string;
  /** `undefined` keeps the current repository when the new project has it. */
  repo: string | null | undefined;
}

/**
 * Interactive project then repository chooser. Lists what the account can
 * reach (numbered, current marked `*`) and returns the choice, or null when
 * the user keeps what they have. Needs a terminal.
 */
export async function pickProjectAndRepo(
  account: IntegrationAccount,
  current: ProjectBinding | null
): Promise<Picked | null> {
  const projects = await listProjects(account.id);
  if (projects.length === 0) {
    throw new IntegrationError(
      "not_found",
      `${account.org} has no project this sign-in can read.`,
      "Check the organization name and that the token can read projects."
    );
  }
  const names = projects.map((p) => p.name);
  const isCurrent = (n: string) => current?.project.toLowerCase() === n.toLowerCase();
  const width = String(projects.length).length;
  console.log(`\nProjects in ${account.org}:`);
  projects.forEach((p, i) => {
    console.log(
      `  ${isCurrent(p.name) ? "*" : " "} ${String(i + 1).padStart(width)}  ${p.name}${p.description ? `  · ${p.description}` : ""}`
    );
  });

  const typed = (
    await ask(`\nProject (number or name${current ? ", Enter to keep" : ""}): `)
  ).trim();
  if (!typed) return null;
  const project = pickFrom(typed, names);

  const chosen = names.find((n) => n.toLowerCase() === project.toLowerCase());
  let repo: string | null | undefined;
  if (chosen) {
    const repos = (await listRepos(account.id, chosen)).map((r) => r.name);
    if (repos.length > 0) {
      console.log(`\nRepositories in ${chosen}:`);
      console.log(`    0  (none)`);
      repos.forEach((r, i) => {
        const here = current?.repo?.toLowerCase() === r.toLowerCase();
        console.log(`  ${here ? "*" : " "} ${String(i + 1).padStart(width)}  ${r}`);
      });
      const answer = (
        await ask(`Repository (number or name, 0 for none, Enter to keep the current one): `)
      ).trim();
      if (answer) {
        repo = answer === "0" || answer.toLowerCase() === "none" ? null : pickFrom(answer, repos);
      }
    }
  }
  return { project, repo };
}
