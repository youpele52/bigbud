import { ProjectId } from "@bigbud/contracts/core/baseSchemas";
import { describe, expect, it, vi } from "vitest";

import { REMOTE_AGENT_SEARCH_MODE } from "../remote-agent/remoteAgentProtocol.search.ts";
import type { SearchRootEntry, SearchRootPlan } from "./SystemSearch.roots.ts";
import { collectUpdates, fakeSearchAgent } from "./SystemSearch.test.helpers.ts";
import {
  runWorkspaceFileSearch,
  SYSTEM_SEARCH_LIMITS,
  type WorkspaceFileSearchDeps,
} from "./SystemSearch.workspaceFiles.ts";

const REMOTE = "ssh:host=box&transport=agent";
const SSH_ONLY = "ssh:host=old&transport=direct-ssh";

function root(rootId: string, tier: SearchRootEntry["tier"], target: string, path: string) {
  return {
    rootId,
    tier,
    executionTargetId: target,
    root: path,
    projectId: ProjectId.makeUnsafe(rootId),
    label: rootId,
  } satisfies SearchRootEntry;
}

const plan: SearchRootPlan = {
  current: root("r0", "currentProject", "local", "/work/current"),
  others: [
    { executionTargetId: "local", roots: [root("r1", "otherProjectFiles", "local", "/work/b")] },
    {
      executionTargetId: REMOTE,
      roots: [
        root("r2", "otherProjectFiles", REMOTE, "/srv/app"),
        root("r3", "remoteOutsideProjects", REMOTE, "/home/me/w"),
      ],
    },
  ],
};

function deps(overrides: Partial<WorkspaceFileSearchDeps> = {}): WorkspaceFileSearchDeps {
  const local = fakeSearchAgent();
  return {
    localConnection: async () => local.connection,
    remoteConnection: () => null,
    isManagedAgentTarget: (target) => target === REMOTE,
    searchDirectSsh: async () => ({ matches: [], truncated: false }),
    legacyFolderSearch: async () => [],
    ...overrides,
  };
}

describe("runWorkspaceFileSearch", () => {
  it("sends the current project first and alone, then one request per target", async () => {
    const local = fakeSearchAgent();
    const remote = fakeSearchAgent();
    const { updates, emitter } = collectUpdates();
    await runWorkspaceFileSearch(
      deps({
        localConnection: async () => local.connection,
        remoteConnection: (target) => (target === REMOTE ? remote.connection : null),
      }),
      { plan, query: "match", emitter, signal: new AbortController().signal },
    );
    expect(local.requests.map((request) => request.roots.map((r) => r.root))).toEqual([
      ["/work/current"],
      ["/work/b"],
    ]);
    expect(local.requests[0]).toMatchObject({
      maxResultsPerRoot: SYSTEM_SEARCH_LIMITS.current.maxResultsPerRoot,
      mode: REMOTE_AGENT_SEARCH_MODE.both,
      deadlineMs: 2_000,
    });
    expect(local.requests[1]!.maxResultsPerRoot).toBe(SYSTEM_SEARCH_LIMITS.local.maxResultsPerRoot);
    expect(remote.requests).toHaveLength(1);
    expect(remote.requests[0]).toMatchObject({ deadlineMs: 3_000, priority: 2 });
    expect(remote.requests[0]!.roots.map((r) => r.rootId)).toEqual(["r2", "r3"]);
    // On a shared agent, the current project's rows come before other projects' rows.
    const firstLocal = updates.find((update) => update.sourceId === "local" && update.items[0]);
    expect(firstLocal?.tier).toBe("currentProject");
    const done = updates.filter((update) => update.state === "done").map((u) => u.tier);
    expect(done.toSorted()).toEqual(
      [
        "currentProject",
        "otherProjectFiles",
        "otherProjectFiles",
        "remoteOutsideProjects",
      ].toSorted(),
    );
    const t6 = updates.find((update) => update.tier === "remoteOutsideProjects" && update.items[0]);
    expect(t6?.items[0]).toMatchObject({ root: "/home/me/w", path: "src/match.ts", kind: "name" });
  });

  it("applies the short-query rules", async () => {
    const local = fakeSearchAgent();
    const run = async (query: string) => {
      local.requests.length = 0;
      const { emitter } = collectUpdates();
      await runWorkspaceFileSearch(deps({ localConnection: async () => local.connection }), {
        plan,
        query,
        emitter,
        signal: new AbortController().signal,
      });
      return local.requests.map((request) => [request.roots.length, request.mode]);
    };
    expect(await run("m")).toEqual([[1, REMOTE_AGENT_SEARCH_MODE.names]]);
    expect(await run("ma")).toEqual([
      [1, REMOTE_AGENT_SEARCH_MODE.names],
      [1, REMOTE_AGENT_SEARCH_MODE.names],
    ]);
    expect(await run("mat")).toEqual([
      [1, REMOTE_AGENT_SEARCH_MODE.both],
      [1, REMOTE_AGENT_SEARCH_MODE.both],
    ]);
  });

  it("reports a disconnected remote at once without delaying the local sources", async () => {
    const local = fakeSearchAgent({ hold: true });
    const controller = new AbortController();
    const { updates, emitter } = collectUpdates("q1", controller.signal);
    const running = runWorkspaceFileSearch(
      deps({ localConnection: async () => local.connection }),
      { plan, query: "match", emitter, signal: controller.signal },
    );
    await vi.waitFor(() => expect(local.inFlight.size).toBe(2));
    expect(updates.filter((u) => u.sourceId === REMOTE)).toEqual([
      expect.objectContaining({
        tier: "otherProjectFiles",
        state: "unavailable",
        reason: "not-connected",
      }),
      expect.objectContaining({
        tier: "remoteOutsideProjects",
        state: "unavailable",
        reason: "not-connected",
      }),
    ]);
    controller.abort();
    await running;
  });

  it("cancels every in-flight agent operation and drops late rows when the query is superseded", async () => {
    const local = fakeSearchAgent({ hold: true });
    const remote = fakeSearchAgent({ hold: true });
    const controller = new AbortController();
    const { updates, emitter } = collectUpdates("q1", controller.signal);
    const running = runWorkspaceFileSearch(
      deps({
        localConnection: async () => local.connection,
        remoteConnection: () => remote.connection,
      }),
      { plan, query: "match", emitter, signal: controller.signal },
    );
    await vi.waitFor(() => expect(local.inFlight.size + remote.inFlight.size).toBe(3));
    const before = updates.length;
    controller.abort();
    await running;
    expect(local.cancels.toSorted()).toEqual(local.requests.map((r) => r.operationId).toSorted());
    expect(remote.cancels).toEqual([remote.requests[0]!.operationId]);
    expect(local.inFlight.size + remote.inFlight.size).toBe(0);
    expect(updates).toHaveLength(before);
  });

  it("falls back to legacy names on old agents and hints at SSH-only hosts", async () => {
    const old = fakeSearchAgent({ capable: false });
    const legacyFolderSearch = vi.fn(async () => [
      { path: "README.md", isDirectory: false, isFile: true, sizeBytes: 5 },
    ]);
    const sshPlan: SearchRootPlan = {
      current: root("r0", "currentProject", SSH_ONLY, "/srv/ssh"),
      others: [plan.others[1]!],
    };
    const searchDirectSsh = vi.fn(async () => ({
      matches: [{ path: "a.txt", line: 2, lineText: "match here" }],
      truncated: false,
    }));
    const { updates, emitter } = collectUpdates();
    await runWorkspaceFileSearch(
      deps({ remoteConnection: () => old.connection, legacyFolderSearch, searchDirectSsh }),
      { plan: sshPlan, query: "match", emitter, signal: new AbortController().signal },
    );
    expect(old.requests).toHaveLength(0);
    expect(legacyFolderSearch).toHaveBeenCalledTimes(2);
    const legacyEnds = updates.filter((u) => u.sourceId === REMOTE && u.items.length === 0);
    expect(legacyEnds.at(-1)).toMatchObject({ state: "partial", reason: "agent-update-available" });
    const ssh = updates.filter((u) => u.sourceId === SSH_ONLY);
    expect(ssh.find((u) => u.items.length > 0)?.items[0]).toMatchObject({
      kind: "content",
      line: 2,
    });
    expect(ssh.at(-1)).toMatchObject({ state: "partial", reason: "use-managed-agent" });
  });

  it("marks the local agent unavailable instead of failing the whole query", async () => {
    const { updates, emitter } = collectUpdates();
    await runWorkspaceFileSearch(
      deps({
        localConnection: async () => {
          throw new Error("agent binary missing");
        },
      }),
      {
        plan: { current: plan.current, others: [] },
        query: "match",
        emitter,
        signal: new AbortController().signal,
      },
    );
    expect(updates).toEqual([
      expect.objectContaining({
        tier: "currentProject",
        state: "unavailable",
        reason: "agent-unavailable",
      }),
    ]);
  });
});
