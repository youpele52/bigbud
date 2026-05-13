import { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { makePiAdapterMethods } from "./Adapter.methods.ts";
import type { ActivePiSession } from "./Adapter.types.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

describe("PiAdapter methods", () => {
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
