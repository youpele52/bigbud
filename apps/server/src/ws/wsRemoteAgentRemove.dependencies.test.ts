import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { ProviderSession } from "@bigbud/contracts/orchestration/provider.ts";

import { configureSshTargetDisconnects } from "../ssh/sshTargetDisconnects.ts";
import { makeRemoveRemoteAgentDependencies } from "./wsRemoteAgentRemove.dependencies.ts";

const AGENT = "ssh:host=box&auth=ssh-key&transport=agent";

function session(patch: Partial<ProviderSession>): ProviderSession {
  return {
    provider: "codex",
    status: "ready",
    runtimeMode: "full-access",
    threadId: "thread-1",
    workspaceExecutionTargetId: AGENT,
    createdAt: "2026-11-20T00:00:00.000Z",
    updatedAt: "2026-11-20T00:00:00.000Z",
    ...patch,
  } as ProviderSession;
}

function make(sessions: ReadonlyArray<ProviderSession>) {
  const stopSession = vi.fn(() => Effect.void);
  const dependencies = makeRemoveRemoteAgentDependencies({
    providerService: { listSessions: () => Effect.succeed(sessions), stopSession },
    terminalManager: { close: vi.fn(() => Effect.void) } as never,
    workspaces: {
      getReadModel: () => Effect.die("unused"),
      getProjectWorktreePaths: () => Effect.die("unused"),
      dispatch: () => Effect.die("unused"),
    },
  });
  return { dependencies, stopSession };
}

describe("makeRemoveRemoteAgentDependencies", () => {
  it("blocks on running or mid-turn sessions that use the target", async () => {
    const { dependencies } = make([
      session({ status: "running" }),
      session({ status: "ready", activeTurnId: "turn-1" as never, provider: "claudeAgent" }),
      session({ status: "ready" }),
      session({ status: "running", workspaceExecutionTargetId: "ssh:host=other" as never }),
    ]);
    const blockers = await Effect.runPromise(dependencies.liveProviderSessionBlockers(AGENT));
    expect(blockers.map((blocker) => blocker.label)).toEqual([
      "A codex chat is still working on this host",
      "A claudeAgent chat is still working on this host",
    ]);
  });

  it("disconnects after removal without stopping any provider session", async () => {
    configureSshTargetDisconnects(undefined, []);
    const { dependencies, stopSession } = make([session({ status: "ready" })]);
    await expect(Effect.runPromise(dependencies.disconnect(AGENT))).resolves.toBe(true);
    expect(stopSession).not.toHaveBeenCalled();
    configureSshTargetDisconnects(undefined, []);
  });
});
