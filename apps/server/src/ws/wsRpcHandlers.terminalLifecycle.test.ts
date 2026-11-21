import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { TerminalExecutionTargetError } from "@bigbud/contracts/workspace/terminal.ts";

import type { WsRpcContext } from "./wsRpcContext";
import { makeWsRpcTerminalLifecycleHandlers } from "./wsRpcHandlers.terminalLifecycle";

const handlers = makeWsRpcTerminalLifecycleHandlers({} as WsRpcContext);

describe("terminal lifecycle handler scaffolding", () => {
  it("accepts keep open as a no-op while no terminal closes when idle", async () => {
    await expect(
      Effect.runPromise(
        handlers[WS_METHODS.terminalKeepOpen]({ threadId: "thread", terminalId: "pane" }),
      ),
    ).resolves.toBeUndefined();
  });

  it("refuses a setup retry with guidance, leaving every terminal unchanged", async () => {
    const failure = await Effect.runPromise(
      handlers[WS_METHODS.terminalRetrySetup]({
        threadId: "thread",
        evict: { threadId: "old", terminalId: "pane" },
      }).pipe(Effect.flip),
    );
    expect(failure).toBeInstanceOf(TerminalExecutionTargetError);
    expect(failure).toMatchObject({ threadId: "thread" });
    expect(failure.message).toContain("Run the setup script again from the project menu.");
  });
});
