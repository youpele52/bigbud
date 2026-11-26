import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { TerminalExecutionTargetError } from "@bigbud/contracts/workspace/terminal.ts";
import { TerminalLimitError } from "@bigbud/contracts/workspace/terminal.limit.ts";

import type { WsRpcContext } from "./wsRpcContext";
import { makeWsRpcTerminalLifecycleHandlers } from "./wsRpcHandlers.terminalLifecycle";

const evict = { threadId: "old", terminalId: "pane" };

describe("terminal lifecycle handlers", () => {
  it("keeps an older backend's behavior without lifecycle support", async () => {
    const handlers = makeWsRpcTerminalLifecycleHandlers({} as WsRpcContext);
    await expect(
      Effect.runPromise(
        handlers[WS_METHODS.terminalKeepOpen]({ threadId: "thread", terminalId: "pane" }),
      ),
    ).resolves.toBeUndefined();
    const failure = await Effect.runPromise(
      handlers[WS_METHODS.terminalRetrySetup]({ threadId: "thread", evict }).pipe(Effect.flip),
    );
    expect(failure).toBeInstanceOf(TerminalExecutionTargetError);
    expect(failure.message).toContain("Run the setup script again from the project menu.");
    await expect(
      Effect.runPromise(handlers[WS_METHODS.terminalCloseDrainingHosts]({})),
    ).resolves.toEqual({ closed: 0, remaining: 0 });
  });

  it("routes Keep open and Close them to the terminal manager", async () => {
    const keepOpen = vi.fn(() => Effect.void);
    const closeDrainingHosts = vi.fn(() => Effect.succeed({ closed: 1, remaining: 0 }));
    const handlers = makeWsRpcTerminalLifecycleHandlers({
      terminalManager: { keepOpen, closeDrainingHosts },
    } as unknown as WsRpcContext);
    await Effect.runPromise(
      handlers[WS_METHODS.terminalKeepOpen]({ threadId: "thread", terminalId: "pane" }),
    );
    expect(keepOpen).toHaveBeenCalledWith({ threadId: "thread", terminalId: "pane" });
    await expect(
      Effect.runPromise(handlers[WS_METHODS.terminalCloseDrainingHosts]({})),
    ).resolves.toEqual({ closed: 1, remaining: 0 });
  });

  it("retries a refused setup, passing a fresh limit refusal through unchanged", async () => {
    const started = {
      status: "started" as const,
      scriptId: "setup",
      scriptName: "Setup",
      terminalId: "setup-setup",
      cwd: "/w",
    };
    const refusal = new TerminalLimitError({ limit: 24, liveCount: 24, candidate: null });
    const retryBlockedSetup = vi
      .fn()
      .mockReturnValueOnce(Effect.succeed(started))
      .mockReturnValueOnce(Effect.fail(refusal))
      .mockReturnValueOnce(Effect.fail(new Error("The setup inputs are no longer available.")));
    const handlers = makeWsRpcTerminalLifecycleHandlers({
      projectSetupScriptRunner: { retryBlockedSetup },
    } as unknown as WsRpcContext);
    const retry = () => handlers[WS_METHODS.terminalRetrySetup]({ threadId: "thread", evict });
    await expect(Effect.runPromise(retry())).resolves.toEqual(started);
    expect(retryBlockedSetup).toHaveBeenCalledWith({ threadId: "thread", evict });
    expect(await Effect.runPromise(retry().pipe(Effect.flip))).toBe(refusal);
    const gone = await Effect.runPromise(retry().pipe(Effect.flip));
    expect(gone).toBeInstanceOf(TerminalExecutionTargetError);
    expect(gone.message).toContain("no longer available");
  });
});
