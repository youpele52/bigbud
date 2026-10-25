import { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

vi.mock("./RpcProcess.ts", () => ({ createPiRpcProcess: vi.fn() }));

import { classifyTurnStartFailure } from "../../../orchestration/Layers/ProviderTurnFailureClassification.ts";
import { makePiAdapterMethods } from "./Adapter.methods.ts";
import type { ActivePiSession } from "./Adapter.types.ts";

const EXITED = "Pi RPC process 'pi' exited (code=1, signal=null).";

function harness(input: { readonly exitedBeforeDispatch: boolean }) {
  const threadId = ThreadId.makeUnsafe("thread-pi-liveness");
  const child = { exitCode: input.exitedBeforeDispatch ? 1 : null, signalCode: null };
  const request = vi.fn(async () => {
    child.exitCode = 1; // The process is gone by the time the request fails.
    throw new Error(EXITED);
  }) as unknown as ActivePiSession["process"]["request"];
  const session = {
    process: {
      child: child as never,
      command: "pi",
      args: [],
      stderrTail: () => "",
      request,
      write: vi.fn(async () => undefined),
      subscribe: () => () => undefined,
      stop: async () => undefined,
    },
    threadId,
    sessionEpoch: 0,
    createdAt: "2026-10-15T10:00:00.000Z",
    runtimeMode: "full-access",
    pendingUserInputs: new Map(),
    turns: [],
    unsubscribe: () => undefined,
    activeTurnId: undefined,
    queuedTurnIds: [],
    currentToolOutputById: new Map(),
    currentToolInfoById: new Map(),
    updatedAt: "2026-10-15T10:00:00.000Z",
  } as unknown as ActivePiSession;
  const methods = makePiAdapterMethods({
    attachmentsDir: "/tmp",
    stateDir: "/tmp/bigbud-state",
    host: "127.0.0.1",
    port: 3773,
    emit: () => Effect.void,
    handleProcessExit: () => Effect.void,
    handleStdoutEvent: () => Effect.void,
    makeSyntheticEvent: (() => Effect.die("unused")) as never,
    runPromise: Effect.runPromise,
    serverSettings: { getSettings: Effect.die("unused") },
    sessions: new Map([[threadId, session]]),
  });
  return { threadId, methods };
}

describe("Pi turn start when the RPC process exited", () => {
  it("an exit observed before dispatch is session-dead", async () => {
    const { threadId, methods } = harness({ exitedBeforeDispatch: true });
    const error = await Effect.runPromise(
      Effect.flip(methods.sendTurn({ threadId, input: "hello" } as never)),
    );
    expect(classifyTurnStartFailure(error)).toBe("session-dead");
  });

  it("an exit observed after the prompt was dispatched is unsafe-to-replay", async () => {
    const { threadId, methods } = harness({ exitedBeforeDispatch: false });
    const error = await Effect.runPromise(
      Effect.flip(methods.sendTurn({ threadId, input: "hello" } as never)),
    );
    expect(classifyTurnStartFailure(error)).toBe("unsafe-to-replay");
  });
});
