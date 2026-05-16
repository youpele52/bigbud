import { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

vi.mock("./RpcProcess.ts", () => ({
  createPiRpcProcess: vi.fn(),
}));

import { makePiAdapterMethods } from "./Adapter.methods.ts";
import type { ActivePiSession } from "./Adapter.types.ts";
import { createPiRpcProcess } from "./RpcProcess.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

describe("PiAdapter methods", () => {
  it("starts remote sessions through the shared Pi RPC process launcher", async () => {
    const threadId = asThreadId("thread-remote-pi");
    const request = vi.fn(async () => ({
      type: "response" as const,
      command: "get_state",
      success: true,
      data: {},
    })) as unknown as ActivePiSession["process"]["request"];
    const subscribe = vi.fn(() => () => undefined);
    const stop = vi.fn(async () => undefined);
    vi.mocked(createPiRpcProcess).mockResolvedValueOnce({
      child: { once: vi.fn() } as never,
      command: "ssh",
      args: ["-T", "root@devbox"],
      stderrTail: () => "",
      request,
      write: vi.fn(async () => undefined),
      subscribe,
      stop,
    });

    const methods = makePiAdapterMethods({
      attachmentsDir: "/tmp",
      emit: () => Effect.void,
      handleProcessExit: () => Effect.void,
      handleStdoutEvent: () => Effect.void,
      makeSyntheticEvent: (() =>
        Effect.succeed({
          provider: "pi",
          type: "session.started",
          eventId: "event-1" as never,
          threadId,
          createdAt: "2026-05-15T00:00:00.000Z",
          payload: {},
        })) as never,
      runPromise: Effect.runPromise,
      serverSettings: {
        getSettings: Effect.succeed({
          providers: {
            pi: {
              binaryPath: "pi",
            },
          },
        } as never),
      },
      sessions: new Map(),
    });

    const session = await Effect.runPromise(
      methods.startSession({
        provider: "pi",
        threadId,
        providerRuntimeExecutionTargetId: "local",
        workspaceExecutionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        cwd: "/root/project",
        runtimeMode: "full-access",
      } as never),
    );

    expect(createPiRpcProcess).toHaveBeenCalledWith({
      binaryPath: "pi",
      providerRuntimeTarget: {
        location: "local",
        executionTargetId: "local",
      },
      workspaceTarget: {
        location: "remote",
        executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        cwd: "/root/project",
      },
      env: process.env,
    });
    expect(session.executionTargetId).toBe("ssh:host=devbox&user=root&port=22&auth=ssh-key");
    expect(session.providerRuntimeExecutionTargetId).toBe("local");
    expect(session.workspaceExecutionTargetId).toBe(
      "ssh:host=devbox&user=root&port=22&auth=ssh-key",
    );
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
  });

  it("interrupts turns with fire-and-forget abort writes", async () => {
    const write = vi.fn(async () => undefined);
    const request = vi.fn(async () => {
      throw new Error("interrupt should not wait for an RPC response");
    });
    const threadId = asThreadId("thread-1");
    const session: ActivePiSession = {
      process: {
        child: {} as never,
        command: "pi",
        args: [],
        stderrTail: () => "",
        request,
        write,
        subscribe: () => () => undefined,
        stop: async () => undefined,
      },
      threadId,
      createdAt: "2026-05-13T00:00:00.000Z",
      runtimeMode: "approval-required",
      pendingUserInputs: new Map(),
      turns: [],
      unsubscribe: () => undefined,
      providerRuntimeExecutionTargetId: "local",
      workspaceExecutionTargetId: "local",
      executionTargetId: "local",
      cwd: undefined,
      model: undefined,
      providerID: undefined,
      thinkingLevel: undefined,
      updatedAt: "2026-05-13T00:00:00.000Z",
      lastError: undefined,
      activeTurnId: undefined,
      pendingTurnEnd: undefined,
      lastUsage: undefined,
      sessionId: undefined,
      sessionFile: undefined,
      currentAssistantMessageId: undefined,
      currentToolOutputById: new Map(),
      currentToolInfoById: new Map(),
    };
    const methods = makePiAdapterMethods({
      attachmentsDir: "/tmp",
      emit: () => Effect.void,
      handleProcessExit: () => Effect.void,
      handleStdoutEvent: () => Effect.void,
      makeSyntheticEvent: (() => Effect.die("unused")) as never,
      runPromise: Effect.runPromise,
      serverSettings: {
        getSettings: Effect.die("unused"),
      },
      sessions: new Map([[threadId, session]]),
    });

    await Effect.runPromise(methods.interruptTurn(threadId));

    expect(write).toHaveBeenCalledWith({ type: "abort" });
    expect(request).not.toHaveBeenCalled();
  });
});
