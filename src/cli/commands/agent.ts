import { agentTargetFrom } from "../args";
import { executeAgentSetupWorkflow, removeAgentWiring } from "../agentWorkflow";

/** `kai setup <agent|all>` / `kai agent <setup|add|register|install> <agent|all>` */
export async function runAgentSetup(args: string[]): Promise<number> {
  const command = args[0];
  let rest = args.slice(1);
  if (command === "agent" || command === "agents") {
    rest = args.slice(2);
  } else if (rest[0] === "agent" || rest[0] === "agents") {
    rest = rest.slice(1);
  }
  return await executeAgentSetupWorkflow(agentTargetFrom(rest), args);
}

/**
 * `kai agent <remove|rm|unlink|unregister> <agent> [--dry-run]`
 * Group alias for `kai remove -a/--agent <name>` and `kai mcp remove <name>`.
 */
export async function runAgentRemove(args: string[]): Promise<number> {
  const target = agentTargetFrom(args.slice(2));
  if (!target) {
    console.error(`[kai] Error: Please specify an agent name to remove.`);
    console.error(`Example: kai agent remove claude`);
    return 1;
  }
  const scope = args.includes("--project")
    ? ("project" as const)
    : args.includes("--global")
      ? ("global" as const)
      : ("auto" as const);
  return removeAgentWiring(target, { dryRun: args.includes("--dry-run"), scope });
}
