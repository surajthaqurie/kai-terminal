/** Flags that name an agent: `-a/--agent` and `-m/--mcp`. */
export const AGENT_FLAGS: readonly string[] = ["-a", "--agent", "-m", "--mcp"];

/** Value after the first of `flags` in `args`, unless it is missing or itself a flag. */
export function flagValue(args: string[], flags: readonly string[]): string | undefined {
  const idx = args.findIndex((a) => flags.includes(a));
  const value = idx === -1 ? undefined : args[idx + 1];
  return value && !value.startsWith("-") ? value : undefined;
}

/** Agent name given as `-a/-m <name>` or as the first positional, lowercased ("" when absent). */
export function agentTargetFrom(rest: string[]): string {
  const positional = rest.find((a) => !a.startsWith("-"));
  return (flagValue(rest, AGENT_FLAGS) || positional || "").toLowerCase();
}
