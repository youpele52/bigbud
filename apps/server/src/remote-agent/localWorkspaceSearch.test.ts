import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { WorkspaceRootNotExistsError } from "../workspace/Services/WorkspacePaths.ts";
import { makeLocalWorkspaceContentSearch } from "./localWorkspaceSearch.ts";
import { fakeSearchConnection as fakeConnection } from "./agentWorkspaceContentSearch.test.helpers.ts";
import { LocalWorkspaceWatchAgentUnavailableError } from "./localWorkspaceWatchAgent.binary.ts";

const INPUT = { cwd: "/work/project", query: "needle", limit: 10 } as const;

const paths = {
  normalizeWorkspaceRoot: (root: string) =>
    root === "/missing"
      ? Effect.fail(
          new WorkspaceRootNotExistsError({ workspaceRoot: root, normalizedWorkspaceRoot: root }),
        )
      : Effect.succeed(`/canonical${root}`),
};

describe("local workspace content search", () => {
  it("searches the normalized root through the shared agent's streaming search", async () => {
    const { connection, requests } = fakeConnection();
    let connections = 0;
    const search = makeLocalWorkspaceContentSearch(
      {
        getConnection: async () => {
          connections += 1;
          return connection;
        },
      },
      paths,
    );
    const result = await Effect.runPromise(search({ ...INPUT, executionTargetId: "local" }));

    expect(result).toEqual({
      matches: [{ path: "src/a.ts", line: 1, column: 14, lineText: "x" }],
      truncated: false,
    });
    expect(connections).toBe(1);
    expect(requests[0]).toMatchObject({
      roots: [{ root: "/canonical/work/project", relativePath: "" }],
      mode: 2,
      maxResults: 11,
      deadlineMs: 2_000,
      priority: 1,
    });
  });

  it("retries once on the restarted agent after a transport loss", async () => {
    const { connection, requests } = fakeConnection({ failures: 1 });
    let connections = 0;
    const search = makeLocalWorkspaceContentSearch(
      {
        getConnection: async () => {
          connections += 1;
          return connection;
        },
      },
      paths,
    );
    const result = await Effect.runPromise(search(INPUT));
    expect(result.matches).toHaveLength(1);
    expect(connections).toBe(2);
    expect(requests).toHaveLength(1);
  });

  it("fails clearly, without any fallback, when the agent is unavailable", async () => {
    const search = makeLocalWorkspaceContentSearch(
      {
        getConnection: async () => {
          throw new LocalWorkspaceWatchAgentUnavailableError(
            "Local workspace watcher agent is unavailable.",
          );
        },
      },
      paths,
    );
    await expect(Effect.runPromise(Effect.flip(search(INPUT)))).resolves.toMatchObject({
      operation: "localWorkspace.searchFileContents",
      detail: "Local workspace watcher agent is unavailable.",
    });
  });

  it("refuses an agent binary without streaming search", async () => {
    const { connection, requests } = fakeConnection({ capable: false });
    const search = makeLocalWorkspaceContentSearch(
      { getConnection: async () => connection },
      paths,
    );
    const error = await Effect.runPromise(Effect.flip(search(INPUT)));
    expect(error).toMatchObject({ detail: expect.stringContaining("out of date") });
    expect(requests).toHaveLength(0);
  });

  it("validates the root before reaching the agent and rejects remote targets", async () => {
    let connections = 0;
    const search = makeLocalWorkspaceContentSearch(
      {
        getConnection: async () => {
          connections += 1;
          throw new Error("unreachable");
        },
      },
      paths,
    );
    const missing = await Effect.runPromise(Effect.flip(search({ ...INPUT, cwd: "/missing" })));
    const nul = await Effect.runPromise(Effect.flip(search({ ...INPUT, cwd: "/a\0b" })));
    const remote = await Effect.runPromise(
      Effect.flip(search({ ...INPUT, executionTargetId: "ssh:example" })),
    );
    expect(missing).toMatchObject({ detail: expect.stringContaining("/missing") });
    expect(nul).toMatchObject({ detail: "Workspace root cannot contain NUL bytes." });
    expect(remote).toMatchObject({
      detail: expect.stringContaining("requires a local execution target"),
    });
    expect(connections).toBe(0);
  });
});
