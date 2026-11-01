/**
 * Per-project git workflow rule: the merge branch, where new work starts and
 * where pull requests go. Stored on the project's binding and handed to agents
 * through the `kai_workflow_rules` tool. Nothing is enforced.
 *
 * Pure: no Node imports, safe for the UI bundle, the CLI and the MCP server.
 */

export interface WorkflowRules {
  /** Branch new work starts from and pull requests target. Empty = the repository's default branch. */
  mergeBranch: string;
}

export const DEFAULT_RULES: Readonly<WorkflowRules> = {
  mergeBranch: "",
};

const MAX_BRANCH = 200;

/** Rules as they may arrive from disk, the CLI or the desktop app: anything. */
export type RulesInput = Partial<Record<keyof WorkflowRules, unknown>>;

export class RulesError extends Error {}

/** A git-safe branch name (a conservative subset of `git check-ref-format`). */
export function isValidBranchName(name: string): boolean {
  if (!name || name.length > MAX_BRANCH) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) {
    return false;
  }
  if (name.includes("..") || name.includes("//") || name.includes("/.") || name.endsWith(".lock")) {
    return false;
  }
  return true;
}

/** `refs/heads/main` and `main` are the same branch. */
export function normalizeBranch(value: string): string {
  return value.trim().replace(/^refs\/heads\//, "");
}

/**
 * The first problem with `input`, or null. Unknown keys are ignored; an absent
 * key means "use the default", so only supplied fields are checked.
 */
export function validateRules(input: RulesInput): string | null {
  if (input.mergeBranch !== undefined) {
    if (typeof input.mergeBranch !== "string") return "Merge branch must be text.";
    const branch = normalizeBranch(input.mergeBranch);
    if (branch && !isValidBranchName(branch)) {
      return `"${input.mergeBranch.trim()}" is not a valid branch name.`;
    }
  }
  return null;
}

/**
 * The overrides worth storing: a merge branch that differs from the default.
 * Storing only differences lets a later default change reach projects that never
 * customized it. Throws `RulesError` when invalid.
 */
export function compactRules(input: RulesInput): Partial<WorkflowRules> {
  const problem = validateRules(input);
  if (problem) throw new RulesError(problem);
  const out: Partial<WorkflowRules> = {};
  if (typeof input.mergeBranch === "string") {
    const branch = normalizeBranch(input.mergeBranch);
    if (branch !== DEFAULT_RULES.mergeBranch) out.mergeBranch = branch;
  }
  return out;
}

/**
 * Overrides read back from disk. A hand-edited bad value, or a field an older
 * version stored and this one dropped, falls back to the default instead of
 * disabling the whole integration.
 */
export function readStoredRules(raw: unknown): Partial<WorkflowRules> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const mergeBranch = (raw as RulesInput).mergeBranch;
  if (mergeBranch === undefined || validateRules({ mergeBranch }) !== null) return undefined;
  const compact = compactRules({ mergeBranch });
  return Object.keys(compact).length > 0 ? compact : undefined;
}

/** Stored overrides on top of the defaults. */
export function effectiveRules(stored?: Partial<WorkflowRules>): WorkflowRules {
  return { ...DEFAULT_RULES, ...stored };
}
