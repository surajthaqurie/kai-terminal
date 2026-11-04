import type { DetectedCoordinates } from "../../rpcTypes";

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** A repository name as Azure has it: no `.git` a git client or mirror may have added. */
function repoName(part: string): string {
  return decode(part).replace(/\.git$/i, "");
}

function cloud(org: string, project: string, repo: string | null): DetectedCoordinates {
  return {
    org: decode(org),
    project: decode(project),
    repo: repo ? repoName(repo) : null,
    baseUrl: `https://dev.azure.com/${decode(org)}`,
  };
}

/**
 * Azure DevOps Server (on-premises): `<base>/<project>/_git/<repo>`, where the
 * project is the segment right before `_git` and everything before it is the
 * server and collection. At least a collection and a project are required, so
 * a bare `<host>/<x>/_git/<repo>` is not guessed at.
 */
function server(remote: string): DetectedCoordinates | null {
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const segments = url.pathname.split("/").filter(Boolean);
  const git = segments.indexOf("_git");
  if (git < 2 || !segments[git + 1]) return null;
  const project = segments[git - 1];
  const base = segments.slice(0, git - 1);
  const collection = base[base.length - 1];
  return {
    org: decode(collection),
    project: decode(project),
    repo: repoName(segments[git + 1]),
    // `url.origin` carries no credentials, so a token embedded in the remote never reaches a stored account.
    baseUrl: `${url.origin}/${base.join("/")}`,
  };
}

/** Other git hosts whose `user@host:v3/a/b/c` paths are just nested groups, never Azure DevOps Server. */
const OTHER_FORGES = new Set([
  "github.com",
  "ssh.github.com",
  "gitlab.com",
  "bitbucket.org",
  "codeberg.org",
  "git.sr.ht",
]);

/**
 * The web address and coordinates an Azure DevOps Server SSH remote points at, as a
 * SUGGESTION: a self-hosted server's SSH address does not say its web address. The
 * port and any virtual directory (`/tfs`) can differ, and the scheme is assumed https.
 * The result is flagged `needsConfirmation` so nothing signs in to it unasked.
 */
function serverSsh(host: string, segments: string[]): DetectedCoordinates | null {
  const name = host.toLowerCase();
  if (!name || OTHER_FORGES.has(name)) return null;
  let base: string[];
  let project: string;
  let repo: string;
  const git = segments.indexOf("_git");
  if (git >= 2 && segments[git + 1]) {
    // <collection path>/<project>/_git/<repo>
    base = segments.slice(0, git - 1);
    project = segments[git - 1];
    repo = segments[git + 1];
  } else if (segments[0] === "v3" && segments.length === 4) {
    // v3/<collection>/<project>/<repo>
    base = [segments[1]];
    project = segments[2];
    repo = segments[3];
  } else {
    return null;
  }
  const collection = base[base.length - 1];
  if (!collection) return null;
  return {
    org: decode(collection),
    project: decode(project),
    repo: repoName(repo),
    baseUrl: `https://${name}/${base.join("/")}`,
    needsConfirmation: true,
  };
}

/** `ssh://[user@]host[:port]/<path>` and `[user@]host:<path>` for a self-hosted server. */
function serverFromSsh(remote: string): DetectedCoordinates | null {
  const scp = /^(?:[^@/\s:]+@)?([^@/\s:]+):(?!\/\/)(.+)$/.exec(remote);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
    return serverSsh(scp[1], scp[2].split("/").filter(Boolean));
  }
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    return null;
  }
  if (url.protocol !== "ssh:") return null;
  return serverSsh(url.hostname, url.pathname.split("/").filter(Boolean));
}

/**
 * Parse a git remote into Azure DevOps coordinates. Handles:
 *   https://[user@]dev.azure.com/<org>/<project>/_git/<repo>
 *   https://<org>.visualstudio.com/[DefaultCollection/]<project>/_git/<repo>
 *   git@ssh.dev.azure.com:v3/<org>/<project>/<repo>   (and ssh://)
 *   <org>@vs-ssh.visualstudio.com:v3/<org>/<project>/<repo>
 *   https://<host>/<collection path>/<project>/_git/<repo>   (Azure DevOps Server)
 *   ssh://<user>@<host>[:port]/<collection path>/<project>/_git/<repo>   (Server, SSH)
 *   <user>@<host>:<collection path>/<project>/_git/<repo>   (Server, SSH)
 *   <user>@<host>:v3/<collection>/<project>/<repo>   (Server, SSH)
 * A cloud URL with no project segment (`.../<org>/_git/<repo>`) means the
 * project shares the repository's name. A Server SSH remote does not say its web
 * address, so the HTTPS address derived from it (`https://<host>/<collection>`,
 * no port, no virtual directory) is returned as a guess flagged `needsConfirmation`:
 * the caller must ask before signing in to it.
 */
export function parseAzureRemote(remote: string): DetectedCoordinates | null {
  const url = remote.trim();
  if (!url) return null;

  const ssh =
    /^(?:ssh:\/\/)?(?:[^@/\s]+@)?(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)[:/]v3\/([^/\s]+)\/([^/\s]+)\/([^/\s]+?)\/?$/i.exec(
      url
    );
  if (ssh) return cloud(ssh[1], ssh[2], ssh[3]);

  const modern =
    /^https?:\/\/(?:[^@/\s]+@)?dev\.azure\.com\/([^/\s]+)\/(?:([^/\s]+)\/)?_git\/([^/\s?#]+)/i.exec(
      url
    );
  if (modern) return cloud(modern[1], modern[2] ?? repoName(modern[3]), modern[3]);

  const legacy =
    /^https?:\/\/(?:[^@/\s]+@)?([a-z0-9][a-z0-9-]*)\.visualstudio\.com\/(?:DefaultCollection\/)?(?:([^/\s]+)\/)?_git\/([^/\s?#]+)/i.exec(
      url
    );
  if (legacy) return cloud(legacy[1], legacy[2] ?? repoName(legacy[3]), legacy[3]);

  return server(url) ?? serverFromSsh(url);
}
