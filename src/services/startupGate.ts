/**
 * Small waits used before a terminal pane starts its shell (FUNC-05, REL-09). Both are
 * bounded: a slow or failed dependency must delay the first prompt, never block it for good.
 */

/** Resolves when `promise` settles or after `ms`, whichever comes first (never rejects). */
export function awaitBounded(promise: Promise<unknown> | undefined, ms: number): Promise<void> {
  if (!promise) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    promise.then(done, done);
  });
}

/** Polls `ready()` every `stepMs` until it is true or `ms` has passed; true when it became ready. */
export async function waitUntil(ready: () => boolean, ms: number, stepMs = 20): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return true;
}

/** Upper bound for the pane to wait for the shell list before spawning (FUNC-05). */
export const SHELL_LIST_WAIT_MS = 500;
/** Upper bound for the pane to wait for its event listeners before spawning (REL-09). */
export const LISTENERS_WAIT_MS = 2000;
