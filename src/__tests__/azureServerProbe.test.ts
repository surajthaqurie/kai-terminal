import { describe, expect, it, vi } from "vitest";
import {
  candidateServerAddresses,
  findServerAddress,
  verifyServerGuess,
} from "../core/integrations/providers/azure-devops/probe";
import { parseAzureRemote } from "../core/integrations/providers/azure-devops/remote";

/** What an Azure DevOps Server sends to a request with no credentials. */
const serverReply = (status = 401): Response =>
  new Response("", { status, headers: { "x-tfs-processid": "abc", "x-vss-e2eid": "def" } });

/** A fake network: only the listed bases have an Azure DevOps Server; anything else is some other web server. */
function network(servers: string[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (servers.some((b) => url === `${b}/_apis/connectionData?api-version=7.0`)) {
      return serverReply();
    }
    if (url.includes("down.local")) throw new Error("ECONNREFUSED");
    return new Response("<html>welcome</html>", { status: 200 }); // a landing page, not the server
  }) as unknown as typeof fetch;
}

describe("Azure DevOps Server address candidates", () => {
  it("tries the standard ports first and then the classic 8080 with /tfs", () => {
    expect(candidateServerAddresses("tfs.corp.local", "DefaultCollection")).toEqual([
      "https://tfs.corp.local/DefaultCollection",
      "https://tfs.corp.local/tfs/DefaultCollection",
      "http://tfs.corp.local/DefaultCollection",
      "http://tfs.corp.local/tfs/DefaultCollection",
      "http://tfs.corp.local:8080/tfs/DefaultCollection",
      "http://tfs.corp.local:8080/DefaultCollection",
      "https://tfs.corp.local:8443/tfs/DefaultCollection",
      "https://tfs.corp.local:8443/DefaultCollection",
    ]);
  });

  it("does not stack a second /tfs when the remote already had one", () => {
    const list = candidateServerAddresses("tfs.corp.local", "tfs/DefaultCollection");
    expect(list[0]).toBe("https://tfs.corp.local/tfs/DefaultCollection");
    expect(list.some((u) => u.includes("/tfs/tfs/"))).toBe(false);
    expect(list).toContain("https://tfs.corp.local/DefaultCollection");
  });

  it("gives nothing to try without a host or a collection", () => {
    expect(candidateServerAddresses("", "X")).toEqual([]);
    expect(candidateServerAddresses("host", "/")).toEqual([]);
  });
});

describe("finding the web address of a Server", () => {
  it("picks the address an Azure DevOps Server answers at, by its headers, not by a 200", async () => {
    const fetchImpl = network(["http://tfs.corp.local:8080/tfs/DefaultCollection"]);
    const found = await findServerAddress(
      candidateServerAddresses("tfs.corp.local", "DefaultCollection"),
      { fetchImpl }
    );
    expect(found).toBe("http://tfs.corp.local:8080/tfs/DefaultCollection");
  });

  it("prefers the earlier candidate when several answer", async () => {
    const fetchImpl = network([
      "https://tfs.corp.local/DefaultCollection",
      "http://tfs.corp.local:8080/tfs/DefaultCollection",
    ]);
    expect(
      await findServerAddress(candidateServerAddresses("tfs.corp.local", "DefaultCollection"), {
        fetchImpl,
      })
    ).toBe("https://tfs.corp.local/DefaultCollection");
  });

  it("returns null when nothing answers, errors included", async () => {
    expect(
      await findServerAddress(["https://down.local/X"], { fetchImpl: network([]) })
    ).toBeNull();
    expect(
      await findServerAddress(["https://other.local/X"], { fetchImpl: network([]) })
    ).toBeNull();
  });

  it("sends no credentials, and does not follow redirects", async () => {
    const fetchImpl = vi.fn(async () => serverReply());
    await findServerAddress(["https://tfs.corp.local/C"], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(Object.keys(init.headers as Record<string, string>)).toEqual(["accept"]);
    expect(init.redirect).toBe("manual");
  });

  it("gives up on a silent address after the timeout instead of hanging", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init.signal?.addEventListener("abort", () => rej(new Error("aborted")));
        })
    );
    const started = Date.now();
    expect(
      await findServerAddress(["https://silent.local/X"], {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 50,
      })
    ).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("verifying the guess an SSH remote gives", () => {
  const ssh = "alice@tfs.corp.local:DefaultCollection/Billing/_git/ledger";

  it("replaces the guessed address with the one that answers, keeping the project and repository", async () => {
    const detected = parseAzureRemote(ssh)!;
    expect(detected.baseUrl).toBe("https://tfs.corp.local/DefaultCollection");
    const fetchImpl = network(["http://tfs.corp.local:8080/tfs/DefaultCollection"]);
    const r = await verifyServerGuess(detected, { fetchImpl });
    expect(r.verified).toBe(true);
    expect(r.detected).toMatchObject({
      baseUrl: "http://tfs.corp.local:8080/tfs/DefaultCollection",
      project: "Billing",
      repo: "ledger",
      org: "DefaultCollection",
      needsConfirmation: true, // found is still the person's to confirm
    });
  });

  it("keeps the guess when nothing answers", async () => {
    const detected = parseAzureRemote(ssh)!;
    const r = await verifyServerGuess(detected, { fetchImpl: network([]) });
    expect(r).toEqual({ detected, verified: false });
  });

  it("does not probe an address that was not a guess", async () => {
    const detected = parseAzureRemote(
      "https://tfs.corp.local/DefaultCollection/Billing/_git/ledger"
    )!;
    const fetchImpl = network([]);
    const r = await verifyServerGuess(detected, { fetchImpl });
    expect(r.verified).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
