import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { ProjectId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationProject } from "@bigbud/contracts/orchestration/orchestration.project.ts";
import type { OrchestrationReadModel } from "@bigbud/contracts/orchestration/orchestration.thread.ts";

import {
  removeRemoteAgentEffect,
  type RemoveRemoteAgentDependencies,
} from "./wsRemoteAgentRemove.ts";
import {
  buildDirectSshReconfigure,
  switchRemoteAgentWorkspacesToDirectSsh,
} from "./wsRemoteAgentRemove.workspaces.ts";
import type { RemoteAgentRemovalResult } from "../remote-agent/remoteAgentInstall.remove.ts";

const AGENT = "ssh:host=box&user=me&auth=ssh-key&transport=agent";
const DIRECT = "ssh:host=box&user=me&auth=ssh-key&transport=direct-ssh";

function dependencies(
  result: RemoteAgentRemovalResult | Error,
  sessionBlockers: ReadonlyArray<{ kind: "process"; label: string }> = [],
) {
  const calls: string[] = [];
  const deps: RemoveRemoteAgentDependencies = {
    remoteAgentInstaller: {
      install: vi.fn(),
      remove: vi.fn(async () => {
        if (result instanceof Error) throw result;
        return result;
      }),
    },
    forgetTarget: async (target) => void calls.push(`forget:${target}`),
    forgetUpdateState: (target) => void calls.push(`update:${target}`),
    liveProviderSessionBlockers: () => Effect.succeed(sessionBlockers),
    disconnect: (target) =>
      Effect.sync(() => {
        calls.push(`disconnect:${target}`);
        return true;
      }),
    switchWorkspacesToDirectSsh: (target) =>
      Effect.sync(() => {
        calls.push(`switch:${target}`);
        return ["project-1" as ProjectId];
      }),
  };
  return { deps, calls };
}

const run = (deps: RemoveRemoteAgentDependencies, switchWorkspacesToDirectSsh?: boolean) =>
  Effect.runPromise(
    removeRemoteAgentEffect(
      {
        executionTargetId: AGENT as never,
        ...(switchWorkspacesToDirectSsh === undefined ? {} : { switchWorkspacesToDirectSsh }),
      },
      deps,
    ),
  );

describe("removeRemoteAgentEffect", () => {
  it("clears local state, disconnects and switches workspaces after removal", async () => {
    const { deps, calls } = dependencies({ outcome: "removed" });
    await expect(run(deps)).resolves.toEqual({
      outcome: "removed",
      disconnected: 1,
      switchedWorkspaceIds: ["project-1"],
    });
    expect(calls).toEqual([
      `forget:${AGENT}`,
      `update:${AGENT}`,
      `disconnect:${AGENT}`,
      `switch:${AGENT}`,
    ]);
  });

  it("never touches a host where a chat is still working", async () => {
    const blockers = [
      { kind: "process" as const, label: "A codex chat is still working on this host" },
    ];
    const { deps, calls } = dependencies({ outcome: "removed" }, blockers);
    await expect(run(deps)).resolves.toEqual({ outcome: "blocked", blockers });
    expect(deps.remoteAgentInstaller?.remove).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("bounds and deduplicates working-chat blockers like every other blocker", async () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      kind: "process" as const,
      label: index < 2 ? "A codex chat is still working on this host" : `Chat ${index}`,
    }));
    const { deps } = dependencies({ outcome: "removed" }, many);
    const result = await run(deps);
    expect(result.outcome === "blocked" && result.blockers).toHaveLength(12);
    expect(result.outcome === "blocked" && result.blockers[0]?.label).toBe(
      "A codex chat is still working on this host",
    );
    expect(result.outcome === "blocked" && result.blockers[1]?.label).toBe("Chat 2");
    expect(result.outcome === "blocked" && result.blockers.at(-1)?.label).toBe("and 8 more");
  });

  it("reports zero disconnected targets when the disconnect fails", async () => {
    const { deps } = dependencies({ outcome: "removed" });
    const failing = { ...deps, disconnect: () => Effect.fail(new Error("store unavailable")) };
    await expect(run(failing, false)).resolves.toMatchObject({ disconnected: 0 });
  });

  it("keeps the transport when asked", async () => {
    const { deps, calls } = dependencies({ outcome: "removed" });
    await expect(run(deps, false)).resolves.toMatchObject({ switchedWorkspaceIds: [] });
    expect(calls).not.toContain(`switch:${AGENT}`);
  });

  it("returns blockers without disconnecting or switching anything", async () => {
    const blockers = [{ kind: "terminal" as const, label: "Terminal in /srv" }];
    const { deps, calls } = dependencies({ outcome: "blocked", blockers });
    await expect(run(deps)).resolves.toEqual({ outcome: "blocked", blockers });
    expect(calls).toEqual([]);
  });

  it("reports a failed removal as a result", async () => {
    const { deps, calls } = dependencies(new Error("ssh: connection refused"));
    const result = await run(deps);
    expect(result.outcome).toBe("failed");
    expect(calls).toEqual([]);
  });

  it("refuses Direct SSH targets", async () => {
    const { deps } = dependencies({ outcome: "removed" });
    const error = await Effect.runPromise(
      Effect.flip(removeRemoteAgentEffect({ executionTargetId: DIRECT as never }, deps)),
    );
    expect(error.message).toContain("Direct SSH");
  });
});

function project(patch: Partial<OrchestrationProject>): OrchestrationProject {
  return {
    id: "project-1" as ProjectId,
    title: "app",
    providerRuntimeExecutionTargetId: AGENT as never,
    workspaceExecutionTargetId: AGENT as never,
    executionTargetId: AGENT as never,
    workspaceRoot: "/srv/app",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-11-20T00:00:00.000Z",
    updatedAt: "2026-11-20T01:00:00.000Z",
    deletingAt: null,
    deletedAt: null,
    ...patch,
  } as OrchestrationProject;
}

describe("switchRemoteAgentWorkspacesToDirectSsh", () => {
  it("builds the Edit dialog's reconfigure with the same host and folder", () => {
    const command = buildDirectSshReconfigure({
      project: project({ providerRuntimeExecutionTargetId: "local" as never }),
      agentTarget: AGENT,
      directTarget: DIRECT,
      worktreePaths: [" /srv/wt ", "/srv/wt", ""],
    });
    expect(command).toMatchObject({
      type: "project.reconfigure",
      projectId: "project-1",
      title: "app",
      providerRuntimeExecutionTargetId: "local",
      workspaceExecutionTargetId: DIRECT,
      executionTargetId: DIRECT,
      workspaceRoot: "/srv/app",
      expectedUpdatedAt: "2026-11-20T01:00:00.000Z",
      verifiedWorktreePaths: ["/srv/wt"],
    });
  });

  it("switches only this host's live workspaces and continues past a failure", async () => {
    const readModel = {
      projects: [
        project({}),
        project({ id: "project-2" as ProjectId }),
        project({ id: "deleted" as ProjectId, deletedAt: "2026-11-20T02:00:00.000Z" }),
        project({ id: "other" as ProjectId, workspaceExecutionTargetId: DIRECT as never }),
      ],
    } as unknown as OrchestrationReadModel;
    const dispatched: string[] = [];
    const switched = await Effect.runPromise(
      switchRemoteAgentWorkspacesToDirectSsh(AGENT, {
        getReadModel: () => Effect.succeed(readModel),
        getProjectWorktreePaths: ({ projectId }) =>
          Effect.succeed({ projectId, worktreePaths: [], truncated: false }),
        dispatch: (command) =>
          command.projectId === "project-2"
            ? Effect.fail(new Error("busy"))
            : Effect.sync(
                () =>
                  void dispatched.push(
                    `${command.projectId}@${command.workspaceExecutionTargetId}`,
                  ),
              ),
      }),
    );
    expect(switched).toEqual(["project-1"]);
    expect(dispatched).toEqual([`project-1@${DIRECT}`]);
  });
});
