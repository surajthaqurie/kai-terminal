/**
 * The Shared Agent engine's process loop. The desktop app starts it (as
 * `dist/cli/shared-agent.js`, never through the `kai` command) and is the only
 * thing that talks to it: one JSON request per line on stdin, one JSON line per
 * answer (carrying the request's `id`) or pushed event (carrying `event`) on
 * stdout. Nothing else may be written to stdout. When stdin closes (the app
 * exited or stopped it) it stops sharing, ends every run and exits.
 *
 * It refuses to start when an AI agent launched it: opening a listener on the
 * network and creating invites is a decision for a person, made in the app.
 */
import readline from "readline";
import type { Readable, Writable } from "stream";
import { assertNotAgentSessionFor, type GuardDeps } from "../teams/guard";
import { SharedAgentService, type ServiceDeps } from "./service";
import type { SharedAgentRequest, SharedAgentResponse } from "./types";

/** Reads requests from `input` until it ends, answering on `output`. Resolves 0 once closed. */
export async function serveLoop(
  input: Readable,
  output: Writable,
  deps: Partial<ServiceDeps> = {}
): Promise<number> {
  const write = (obj: unknown) => output.write(`${JSON.stringify(obj)}\n`);
  const service = new SharedAgentService({ ...deps, emit: (event) => write(event) });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const inflight = new Set<Promise<void>>();

  const answer = async (line: string): Promise<void> => {
    let id: unknown;
    let response: SharedAgentResponse;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      const obj = parsed as Record<string, unknown>;
      id = obj.id;
      if (typeof obj.op !== "string") throw new Error("missing op");
      response = await service.handle(obj as unknown as SharedAgentRequest);
    } catch {
      response = { ok: false, error: { code: "bad_request", message: "Invalid request." } };
    }
    write({ id, ...response });
  };

  return new Promise<number>((resolve) => {
    rl.on("line", (line) => {
      if (!line.trim()) return;
      const p = answer(line).finally(() => inflight.delete(p));
      inflight.add(p);
    });
    rl.on("close", () => {
      void (async () => {
        await Promise.allSettled([...inflight]);
        await service.close();
        resolve(0);
      })();
    });
  });
}

export interface EngineDeps {
  env?: NodeJS.ProcessEnv;
  processes?: GuardDeps["processes"];
  input?: Readable;
  output?: Writable;
  /** Where the refusal goes (default stderr; the app discards it). */
  errors?: Writable;
  service?: Partial<ServiceDeps>;
}

/** Starts the engine on stdin / stdout. Resolves with the exit code. */
export async function runEngine(deps: EngineDeps = {}): Promise<number> {
  try {
    await assertNotAgentSessionFor(
      {
        what: "Shared Agent",
        hint: "Turn sharing on yourself from AI Providers → Shared Agent in Kai Terminal.",
      },
      deps.env ?? process.env,
      { processes: deps.processes }
    );
  } catch (e) {
    (deps.errors ?? process.stderr).write(`[kai] ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const input = deps.input ?? process.stdin;
  if (!deps.input) {
    const stop = () => process.stdin.destroy(); // closes the loop, which cleans up
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  }
  return serveLoop(input, deps.output ?? process.stdout, deps.service);
}
