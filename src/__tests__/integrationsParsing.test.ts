import { describe, expect, it } from "vitest";
import { findProvider, resolveProviderId } from "../core/integrations/providerCatalog";
import { htmlToText } from "../core/integrations/format";
import { parseAzureRemote } from "../core/integrations/providers/azure-devops/remote";
import {
  buildWiql,
  identityName,
  mapBuild,
  mapFailures,
  mapRelations,
  mapReviewers,
  mapThreads,
  mapWorkItemDetail,
  wiqlString,
} from "../core/integrations/providers/azure-devops/mapper";

describe("provider catalog", () => {
  it("resolves ids and aliases case-insensitively", () => {
    expect(resolveProviderId("azure")).toBe("azure-devops");
    expect(resolveProviderId("ADO")).toBe("azure-devops");
    expect(resolveProviderId("azure-devops")).toBe("azure-devops");
    expect(resolveProviderId("jira")).toBeNull();
    expect(resolveProviderId("")).toBeNull();
    expect(findProvider("  azure ")?.label).toBe("Azure DevOps");
  });
});

describe("parseAzureRemote", () => {
  const cases: Array<[string, { org: string; project: string; repo: string | null }]> = [
    [
      "https://dev.azure.com/contoso/Payments/_git/api",
      { org: "contoso", project: "Payments", repo: "api" },
    ],
    [
      "https://user@dev.azure.com/contoso/Payments/_git/api",
      { org: "contoso", project: "Payments", repo: "api" },
    ],
    [
      "https://dev.azure.com/contoso/My%20Project/_git/web%20app",
      { org: "contoso", project: "My Project", repo: "web app" },
    ],
    ["https://dev.azure.com/contoso/_git/api", { org: "contoso", project: "api", repo: "api" }],
    [
      "git@ssh.dev.azure.com:v3/contoso/Payments/api",
      { org: "contoso", project: "Payments", repo: "api" },
    ],
    [
      "ssh://git@ssh.dev.azure.com/v3/contoso/Payments/api",
      { org: "contoso", project: "Payments", repo: "api" },
    ],
    [
      "https://contoso.visualstudio.com/Payments/_git/api",
      { org: "contoso", project: "Payments", repo: "api" },
    ],
    [
      "https://contoso.visualstudio.com/DefaultCollection/Payments/_git/api",
      { org: "contoso", project: "Payments", repo: "api" },
    ],
    [
      "contoso@vs-ssh.visualstudio.com:v3/contoso/Payments/api",
      { org: "contoso", project: "Payments", repo: "api" },
    ],
  ];

  it.each(cases)("parses %s", (url, expected) => {
    expect(parseAzureRemote(url)).toMatchObject(expected);
  });

  it("always reports the cloud base URL of the organization", () => {
    expect(parseAzureRemote("https://contoso.visualstudio.com/Payments/_git/api")?.baseUrl).toBe(
      "https://dev.azure.com/contoso"
    );
  });

  it.each(["https://github.com/acme/api.git", "git@github.com:acme/api.git", "", "not a url"])(
    "ignores %s",
    (url) => {
      expect(parseAzureRemote(url)).toBeNull();
    }
  );
});

describe("parseAzureRemote: servers, .git and credentials", () => {
  it("reads an Azure DevOps Server remote: collection, project and repository", () => {
    expect(
      parseAzureRemote("https://tfs.corp.local/tfs/DefaultCollection/Billing/_git/ledger")
    ).toEqual({
      org: "DefaultCollection",
      project: "Billing",
      repo: "ledger",
      baseUrl: "https://tfs.corp.local/tfs/DefaultCollection",
    });
    // No virtual directory: the collection comes right after the host.
    expect(
      parseAzureRemote("https://tfs.corp.local/DefaultCollection/Billing/_git/ledger")
    ).toMatchObject({
      org: "DefaultCollection",
      baseUrl: "https://tfs.corp.local/DefaultCollection",
    });
  });

  it("keeps a port and decodes names", () => {
    expect(
      parseAzureRemote("http://tfs:8080/tfs/DefaultCollection/My%20Proj/_git/repo.git")
    ).toEqual({
      org: "DefaultCollection",
      project: "My Proj",
      repo: "repo",
      baseUrl: "http://tfs:8080/tfs/DefaultCollection",
    });
  });

  it("never lets a credential embedded in the remote reach the detected address", () => {
    const found = parseAzureRemote(
      "https://alice:s3cret-token@tfs.corp.local/DefaultCollection/Billing/_git/ledger"
    );
    expect(JSON.stringify(found)).not.toContain("s3cret-token");
    expect(JSON.stringify(found)).not.toContain("alice");
    const cloud = parseAzureRemote(
      "https://alice:s3cret-token@dev.azure.com/contoso/Payments/_git/api"
    );
    expect(JSON.stringify(cloud)).not.toContain("s3cret-token");
  });

  it("strips a trailing .git from cloud and server repositories", () => {
    expect(parseAzureRemote("https://dev.azure.com/o/p/_git/r.git")?.repo).toBe("r");
    expect(parseAzureRemote("https://dev.azure.com/o/_git/r.git")).toMatchObject({
      project: "r",
      repo: "r",
    });
    expect(parseAzureRemote("git@ssh.dev.azure.com:v3/o/p/r.git")?.repo).toBe("r");
  });

  it("does not guess when a server URL has no project segment, or is SSH", () => {
    expect(parseAzureRemote("https://tfs.corp.local/Billing/_git/ledger")).toBeNull();
    expect(parseAzureRemote("https://tfs.corp.local/_git/ledger")).toBeNull();
    expect(
      parseAzureRemote("ssh://tfs.corp.local:22/tfs/DefaultCollection/Billing/_git/ledger")
    ).toBeNull();
    expect(parseAzureRemote("https://github.com/acme/_git/thing")).toBeNull();
  });
});

describe("html to text", () => {
  it("strips tags, keeps structure and decodes entities", () => {
    const html =
      "<div>Fix the <b>login</b> flow&nbsp;now</div><ul><li>one</li><li>a &amp; b</li></ul><script>alert(1)</script>";
    expect(htmlToText(html)).toBe("Fix the login flow now\n\n- one\n- a & b");
  });

  it("decodes numeric entities and leaves unknown ones alone", () => {
    expect(htmlToText("&#65;&#x42; &bogus;")).toBe("AB &bogus;");
  });

  it("is empty for missing input", () => {
    expect(htmlToText(undefined)).toBe("");
    expect(htmlToText(null)).toBe("");
  });
});

describe("WIQL building", () => {
  it("escapes single quotes so a value cannot break out of its literal", () => {
    expect(wiqlString("o'brien")).toBe("'o''brien'");
    const q = buildWiql({ text: "x' OR [System.Id] > 0 --" });
    expect(q).toContain("CONTAINS 'x'' OR [System.Id] > 0 --'");
  });

  it("scopes to the project and maps `me` to @Me", () => {
    const q = buildWiql({ state: "Active", type: "Bug", assignedTo: "me" });
    expect(q).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.State] = 'Active' AND [System.WorkItemType] = 'Bug' AND [System.AssignedTo] = @Me ORDER BY [System.ChangedDate] DESC"
    );
    expect(buildWiql({ assignedTo: "Ana Ruiz" })).toContain("[System.AssignedTo] = 'Ana Ruiz'");
  });
});

describe("Azure DevOps mappers", () => {
  it("reads identities as objects or strings", () => {
    expect(identityName({ displayName: "Ana", uniqueName: "ana@x.com" })).toBe("Ana");
    expect(identityName({ uniqueName: "ana@x.com" })).toBe("ana@x.com");
    expect(identityName("Ana <ana@x.com>")).toBe("Ana <ana@x.com>");
    expect(identityName(undefined)).toBeUndefined();
  });

  it("maps a work item with HTML bodies, tags and links", () => {
    const detail = mapWorkItemDetail(
      {
        id: 42,
        fields: {
          "System.WorkItemType": "Bug",
          "System.Title": "Crash on save",
          "System.State": "Active",
          "System.AssignedTo": { displayName: "Ana" },
          "System.Tags": "ui; regression ;",
          "System.Description": "<p>Steps</p><p>1. click</p>",
          "Microsoft.VSTS.Common.Priority": 1,
        },
        relations: [
          {
            rel: "System.LinkTypes.Hierarchy-Reverse",
            url: "https://dev.azure.com/o/_apis/wit/workItems/7",
          },
          {
            rel: "ArtifactLink",
            url: "vstfs:///Git/PullRequestId/p%2Fr%2F19",
            attributes: { name: "Pull Request" },
          },
          {
            rel: "ArtifactLink",
            url: "vstfs:///Git/Commit/p%2Fr%2Fabc",
            attributes: { name: "Fixed in Commit" },
          },
        ],
      },
      "https://dev.azure.com/o",
      "My Proj"
    );
    expect(detail).toMatchObject({
      id: 42,
      type: "Bug",
      title: "Crash on save",
      assignedTo: "Ana",
      tags: ["ui", "regression"],
      description: "Steps\n1. click",
      priority: 1,
      url: "https://dev.azure.com/o/My%20Proj/_workitems/edit/42",
    });
    expect(detail.relations).toEqual([
      { kind: "parent", id: 7 },
      { kind: "pull-request", id: 19 },
      { kind: "commit" },
    ]);
  });

  it("survives a malformed artifact link", () => {
    expect(
      mapRelations([{ rel: "ArtifactLink", url: "vstfs:///Git/PullRequestId/%E0%A4%A" }])
    ).toEqual([{ kind: "pull-request" }]);
  });

  it("names reviewer votes", () => {
    expect(
      mapReviewers([
        { displayName: "A", vote: 10, isRequired: true },
        { displayName: "B", vote: -10 },
      ])
    ).toEqual([
      { name: "A", vote: "approved", required: true },
      { name: "B", vote: "rejected", required: false },
    ]);
  });

  it("keeps human review threads and drops system and deleted ones", () => {
    const { threads, total } = mapThreads({
      value: [
        { id: 1, isDeleted: true, comments: [{ content: "gone" }] },
        { id: 2, comments: [{ commentType: "system", content: "Ana updated the PR" }] },
        {
          id: 3,
          status: "active",
          threadContext: { filePath: "/src/a.ts", rightFileStart: { line: 12 } },
          comments: [
            { author: { displayName: "Bo" }, content: "<p>Rename this</p>", commentType: "text" },
            { commentType: "system", content: "ignored" },
          ],
        },
      ],
    });
    expect(total).toBe(1);
    expect(threads[0]).toMatchObject({ id: 3, filePath: "/src/a.ts", line: 12 });
    expect(threads[0].comments).toEqual([{ author: "Bo", at: undefined, text: "Rename this" }]);
  });

  it("maps a build and its failed leaf steps", () => {
    const build = mapBuild(
      {
        id: 9,
        buildNumber: "20261029.1",
        status: "completed",
        result: "failed",
        sourceBranch: "refs/heads/main",
        sourceVersion: "0123456789abcdef",
        definition: { name: "CI" },
      },
      "https://dev.azure.com/o",
      "P"
    );
    expect(build).toMatchObject({
      number: "20261029.1",
      branch: "main",
      commit: "0123456789ab",
      definition: "CI",
    });
    expect(build.url).toContain("buildId=9");

    const failures = mapFailures({
      records: [
        { type: "Stage", name: "Build", result: "failed", issues: [] },
        {
          type: "Task",
          name: "npm test",
          result: "failed",
          log: { id: 12 },
          issues: [
            { type: "error", message: "2 tests failed" },
            { type: "warning", message: "meh" },
          ],
        },
        { type: "Task", name: "lint", result: "succeeded", log: { id: 13 } },
      ],
    });
    expect(failures).toEqual([{ step: "npm test", logId: 12, issues: ["2 tests failed"] }]);
  });
});
