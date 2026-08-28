import { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

vi.mock("./RpcProcess.ts", () => ({ createPiRpcProcess: vi.fn() }));
vi.mock("../../../orchestration-tools/PiOrchestrationBridge.ts", () => ({
  createPiOrchestrationBridge: vi.fn(async () => ({
    extensionPath: "/tmp/pi-orchestration/bridge.ts",
    bridgeDir: "/tmp/pi-orchestration",
    extraArgs: [],
    httpConfig: { host: "127.0.0.1", port: 3000, threadId: "thread-pi", token: "token" },
    cleanup: async () => undefined,
  })),
}));

import { makePiAdapterMethods } from "./Adapter.methods.ts";
import { createPiRpcProcess } from "./RpcProcess.ts";

describe("Pi start-session readiness", () => {
  it("fails and stops the process when the initial RPC handshake times out", async () => {
    const threadId = ThreadId.makeUnsafe("thread-pi-readiness-timeout");
    const stop = vi.fn(async () => undefined);
    vi.mocked(createPiRpcProcess).mockResolvedValueOnce({
      child: { once: vi.fn() } as never,
      command: "pi",
      args: ["--mode", "rpc"],
      stderrTail: () => "",
      request: vi.fn(async () => {
        throw new Error("Timed out waiting for Pi RPC response to 'get_state'.");
      }),
      write: vi.fn(async () => undefined),
      subscribe: vi.fn(() => () => undefined),
      stop,
    });
    const sessions = new Map();
    const methods = makePiAdapterMethods({
      attachmentsDir: "/tmp",
      stateDir: "/tmp/bigbud-state",
      host: "127.0.0.1",
      port: 3773,
      emit: () => Effect.void,
      handleProcessExit: () => Effect.void,
      handleStdoutEvent: () => Effect.void,
      makeSyntheticEvent: (() => Effect.die("startup must not emit ready events")) as never,
      runPromise: Effect.runPromise,
      serverSettings: {
        getSettings: Effect.succeed({ providers: { pi: { binaryPath: "pi" } } } as never),
      },
      sessions,
    });

    await expect(
      Effect.runPromise(
        methods.startSession({
          provider: "pi",
          threadId,
          cwd: "/srv/project",
          runtimeMode: "full-access",
        }),
      ),
    ).rejects.toMatchObject({ _tag: "ProviderAdapterRequestError" });
    expect(stop).toHaveBeenCalledOnce();
    expect(sessions.has(threadId)).toBe(false);
  });
});
