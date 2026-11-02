/**
 * Per-project git workflow rules: the merge branch (where new work starts and
 * where pull requests go) and an optional branch naming pattern (a regular
 * expression). Stored on the project's binding and handed to agents through the
 * `kai_workflow_rules` tool. Nothing is enforced.
 *
 * Pure: no Node imports, safe for the UI bundle, the CLI and the MCP server.
 */

export interface WorkflowRules {
  /** Branch new work starts from and pull requests target. Empty = the repository's default branch. */
  mergeBranch: string;
  /** Regular expression a work branch name should match. Empty = no rule, the agent picks the name. */
  branchPattern: string;
}

export const DEFAULT_RULES: Readonly<WorkflowRules> = {
  mergeBranch: "",
  branchPattern: "",
};

const MAX_BRANCH = 200;
/** Longest branch naming pattern accepted. */
export const MAX_PATTERN = 200;

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

export interface PatternCheck {
  /** Why the pattern cannot be saved, or null. */
  error: string | null;
  /** A suggestion that does not stop a save, or null. */
  warning: string | null;
}

const OK: PatternCheck = { error: null, warning: null };

/** The engine's own reason, without its "Invalid regular expression: /…/: " lead-in. */
function engineReason(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Invalid regular expression:\s*(\/.*\/[a-z]*:\s*)?/, "").replace(/\.$/, "");
}

/**
 * Checks a branch naming pattern. An empty string is valid and means "no rule".
 * Used by the desktop form (live, as the user types), the CLI and the MCP tool, so
 * every surface gives the same message.
 */
export function checkBranchPattern(raw: string): PatternCheck {
  if (raw === "") return OK;
  if (raw.trim() === "") {
    return {
      error: "Branch naming can't be only spaces. Clear the field to remove it.",
      warning: null,
    };
  }
  if (raw !== raw.trim()) {
    return { error: "Remove the spaces before or after the pattern.", warning: null };
  }
  if (raw.length > MAX_PATTERN) {
    return {
      error: `Pattern is too long (${raw.length} of ${MAX_PATTERN} characters).`,
      warning: null,
    };
  }
  if (/^\/.*\/[a-z]*$/.test(raw)) {
    return {
      error:
        "Enter the pattern without the slashes or flags, for example ^feature/\\d+$ (not /^feature\\/\\d+$/i).",
      warning: null,
    };
  }

  let re: RegExp;
  try {
    re = new RegExp(raw);
  } catch (err) {
    return { error: `Not a valid regular expression: ${engineReason(err)}.`, warning: null };
  }

  // A repeated group inside a repeat, like (a+)+, can make the matcher hang.
  // Character classes are blanked first so `([+-]x)+` is not mistaken for one.
  const withoutClasses = raw.replace(/\[(?:[^\]\\]|\\.)*\]/g, "x");
  if (/\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/.test(withoutClasses)) {
    return {
      error: "This pattern repeats a repeat (like (a+)+) and could hang the matcher. Simplify it.",
      warning: null,
    };
  }
  if (re.test("")) {
    return {
      error: "This pattern matches an empty name, so it would accept anything. Make it stricter.",
      warning: null,
    };
  }
  if (!raw.startsWith("^") || !raw.endsWith("$")) {
    return {
      error: null,
      warning:
        "Tip: start with ^ and end with $ so the whole branch name has to match, not just part of it.",
    };
  }
  return OK;
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
  if (input.branchPattern !== undefined) {
    if (typeof input.branchPattern !== "string") return "Branch naming must be text.";
    const { error } = checkBranchPattern(input.branchPattern);
    if (error) return error;
  }
  return null;
}

/**
 * The overrides worth storing: values that differ from the default. Storing only
 * differences lets a later default change reach projects that never customized
 * it. Throws `RulesError` when invalid.
 */
export function compactRules(input: RulesInput): Partial<WorkflowRules> {
  const problem = validateRules(input);
  if (problem) throw new RulesError(problem);
  const out: Partial<WorkflowRules> = {};
  if (typeof input.mergeBranch === "string") {
    const branch = normalizeBranch(input.mergeBranch);
    if (branch !== DEFAULT_RULES.mergeBranch) out.mergeBranch = branch;
  }
  if (typeof input.branchPattern === "string") {
    if (input.branchPattern !== DEFAULT_RULES.branchPattern)
      out.branchPattern = input.branchPattern;
  }
  return out;
}

/**
 * Overrides read back from disk. A hand-edited bad value, or a field an older
 * version stored and this one dropped, falls back to the default instead of
 * disabling the whole integration. Each field is judged on its own.
 */
export function readStoredRules(raw: unknown): Partial<WorkflowRules> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const stored = raw as RulesInput;
  const picked: RulesInput = {};
  for (const key of ["mergeBranch", "branchPattern"] as const) {
    const value = stored[key];
    if (value !== undefined && validateRules({ [key]: value }) === null) picked[key] = value;
  }
  const compact = compactRules(picked);
  return Object.keys(compact).length > 0 ? compact : undefined;
}

/** Stored overrides on top of the defaults. */
export function effectiveRules(stored?: Partial<WorkflowRules>): WorkflowRules {
  return { ...DEFAULT_RULES, ...stored };
}
