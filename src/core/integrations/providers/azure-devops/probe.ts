import type { DetectedCoordinates } from "../../rpcTypes";

/**
 * Finding the web address of an Azure DevOps Server from its SSH remote.
 *
 * An SSH remote names the host and the collection but not the web address: the scheme, the port
 * and a virtual directory (`/tfs`) can all differ. Instead of leaving the person to know them,
 * each likely address is asked, without credentials, whether an Azure DevOps Server answers
 * there. Nothing is signed in to and no token is sent; the one that answers is offered for
 * confirmation like any other guess.
 */

/** What Azure DevOps Server sends back even to a request with no credentials. */
const SERVER_HEADER = /^(?:x-tfs-|x-vss-)/i;

export interface ProbeDeps {
  fetchImpl?: typeof fetch;
  /** How long to wait for one address (ms). */
  timeoutMs?: number;
}

/**
 * The web addresses to try for `<host>` and its collection path, most likely first. `collection` is
 * the path below the server root as the remote gave it (`DefaultCollection`, or `tfs/Fabrikam`).
 */
export function candidateServerAddresses(host: string, collection: string): string[] {
  const path = collection.replace(/^\/+|\/+$/g, "");
  if (!host || !path) return [];
  const hasVirtualDir = /^tfs(\/|$)/i.test(path);
  const withDir = hasVirtualDir ? path : `tfs/${path}`;
  const withoutDir = hasVirtualDir ? path.replace(/^tfs\/?/i, "") : path;
  const out: string[] = [];
  const add = (origin: string, p: string) => {
    if (!p) return;
    const url = `${origin}/${p}`;
    if (!out.includes(url)) out.push(url);
  };
  // Current servers answer on the standard ports with the collection at the root; the older
  // default was port 8080 with a `/tfs` virtual directory. Both forms are tried everywhere, the
  // one the remote gave first on the standard ports.
  const given = path;
  const other = hasVirtualDir ? withoutDir : withDir;
  add(`https://${host}`, given);
  add(`https://${host}`, other);
  add(`http://${host}`, given);
  add(`http://${host}`, other);
  for (const origin of [`http://${host}:8080`, `https://${host}:8443`]) {
    add(origin, withDir);
    add(origin, withoutDir);
  }
  return out;
}

/** True when an Azure DevOps Server answers at `base` (it need not accept the request). */
async function answersAsAzureDevOps(base: string, deps: ProbeDeps): Promise<boolean> {
  const doFetch = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 3000);
  try {
    const res = await doFetch(`${base}/_apis/connectionData?api-version=7.0`, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: controller.signal,
    });
    // An unauthenticated request is normally refused (401, or 203 for a sign-in page); what marks
    // the server is the headers it sets, not that it accepted the request. A landing page or a
    // proxy answering on the same address has no such headers.
    const answered = res.status === 200 || res.status === 203 || res.status === 401;
    return answered && [...res.headers.keys()].some((h) => SERVER_HEADER.test(h));
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The first candidate address that answers as an Azure DevOps Server, in the order given, or null.
 * All are tried at once, so the wait is one timeout, not one per address.
 */
export async function findServerAddress(
  candidates: readonly string[],
  deps: ProbeDeps = {}
): Promise<string | null> {
  const answers = await Promise.all(candidates.map((c) => answersAsAzureDevOps(c, deps)));
  const i = answers.indexOf(true);
  return i === -1 ? null : candidates[i];
}

/**
 * The collection path of a suggested Server address (what follows the host), as the SSH remote gave it.
 */
function collectionPathOf(baseUrl: string): { host: string; path: string } | null {
  try {
    const u = new URL(baseUrl);
    return { host: u.hostname, path: u.pathname };
  } catch {
    return null;
  }
}

/**
 * `detected` with its address replaced by the one that answers, when one does. Only a guess
 * (`needsConfirmation`) is probed; the result keeps `needsConfirmation`, because a server that answers
 * is still the person's to confirm before signing in.
 */
export async function verifyServerGuess(
  detected: DetectedCoordinates,
  deps: ProbeDeps = {}
): Promise<{ detected: DetectedCoordinates; verified: boolean }> {
  if (!detected.needsConfirmation) return { detected, verified: false };
  const parts = collectionPathOf(detected.baseUrl);
  if (!parts) return { detected, verified: false };
  const found = await findServerAddress(candidateServerAddresses(parts.host, parts.path), deps);
  if (!found) return { detected, verified: false };
  return { detected: { ...detected, baseUrl: found }, verified: true };
}
