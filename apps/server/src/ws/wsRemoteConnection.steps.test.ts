import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ProviderSession } from "@bigbud/contracts/orchestration/provider.ts";
import type { ThreadId } from "@bigbud/contracts";

import { makeRemoteDisconnectSteps } from "./wsRemoteConnection.steps.ts";
import { RemoteTargetDisconnectedError } from "../ssh/sshTargetDisconnects.ts";

const target = "ssh:host=box&transport=direct-ssh";

function session(threadId: string, fields: Partial<ProviderSession>): ProviderSession {
  return {
    provider: "codex",
    status: "ready",
    runtimeMode: "full-access",
    threadId: threadId as ThreadId,
    createdAt: "2026-11-06T00:00:00.000Z",
    updatedAt: "2026-11-06T00:00:00.000Z",
    ...fields,
  } as ProviderSession;
}

function harness(options: { readonly agentPty: boolean }) {
  const stopSession = vi.fn((_input: { threadId: string; sessionEpoch?: number }) => Effect.void);
  const close = vi.fn((_input: { threadId: string; terminalId?: string }) => Effect.void);
  const calls: string[] = [];
  const steps = makeRemoteDisconnectSteps({
    providerService: {
      listSessions: () =>
        Effect.succeed([
          session("runtime", { providerRuntimeExecutionTargetId: target, sessionEpoch: 4 }),
          session("workspace", { workspaceExecutionTargetId: target }),
          session("legacy", { executionTargetId: target }),
          session("elsewhere", { workspaceExecutionTargetId: "ssh:host=other" }),
        ]),
      stopSession: stopSession as never,
    },
    terminalManager: {
      close: close as never,
      listExecutionTargetSessions: () =>
        Effect.succeed([{ threadId: "thread-1", terminalId: "default" }]),
    },
    usesRemoteAgentPty: () => options.agentPty,
    disconnectRemoteAgent: (id, error) => void calls.push(`agent:${id}:${error.message}`),
    closePasswordSession: async (id) => void calls.push(`password:${id}`),
    forgetMonitorTarget: (id) => void calls.push(`monitor:${id}`),
  });
  const runAll = () =>
    Effect.runPromise(
      Effect.forEach(steps, (step) => step.run(target, new RemoteTargetDisconnectedError(target)), {
        discard: true,
      }),
    );
  return { steps, stopSession, close, calls, runAll };
}

describe("remote disconnect steps", () => {
  it("runs in the planned order", () => {
    expect(harness({ agentPty: false }).steps.map((step) => step.name)).toEqual([
      "provider-sessions",
      "direct-ssh-terminals",
      "remote-agent-connections",
      "password-session",
      "ssh-monitor",
    ]);
  });

  it("stops sessions bound to the target by runtime, workspace or legacy target", async () => {
    const { stopSession, close, calls, runAll } = harness({ agentPty: false });
    await runAll();
    expect(stopSession.mock.calls.map(([input]) => input)).toEqual([
      { threadId: "runtime", sessionEpoch: 4 },
      { threadId: "workspace" },
      { threadId: "legacy" },
    ]);
    expect(close).toHaveBeenCalledWith({ threadId: "thread-1", terminalId: "default" });
    expect(calls).toEqual([
      `agent:${target}:Remote workspace is disconnected. Connect it to continue.`,
      `password:${target}`,
      `monitor:${target}`,
    ]);
  });

  it("leaves remote-agent PTYs running on the host", async () => {
    const { close, runAll } = harness({ agentPty: true });
    await runAll();
    expect(close).not.toHaveBeenCalled();
  });

  it("keeps stopping other sessions when one stop fails", async () => {
    const { steps, stopSession } = harness({ agentPty: false });
    stopSession.mockImplementationOnce(() => Effect.die(new Error("adapter gone")));
    await Effect.runPromise(steps[0]!.run(target, new RemoteTargetDisconnectedError(target)));
    expect(stopSession).toHaveBeenCalledTimes(3);
  });
});
