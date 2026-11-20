import * as Effect from "effect/Effect";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { TerminalExecutionTargetError } from "@bigbud/contracts/workspace/terminal.ts";
import { describe, expect, it, vi } from "vitest";
import { makeShellProfileHandlers } from "./wsRpcHandlers.shellProfiles";
import type { WsRpcContext } from "./wsRpcContext";

describe("execution-host shell inventory RPC", () => {
  it("delegates only the existing-pane identifiers without launching a terminal", async () => {
    const inventory = {
      host: { kind: "ssh", hostId: "remote" },
      profiles: [],
      exactProfileLaunchesEnabled: false,
      runtimeGeneration: "retained",
    };
    const listShellProfiles = vi.fn(() => Effect.succeed(inventory));
    const open = vi.fn();
    const restart = vi.fn();
    const context = {
      terminalManager: { listShellProfiles, open, restart },
    } as unknown as WsRpcContext;
    const input = { threadId: "thread", terminalId: "pane" };
    const handler = makeShellProfileHandlers(context)[WS_METHODS.terminalShellProfiles];
    expect(await Effect.runPromise(handler(input))).toEqual(inventory);
    expect(listShellProfiles).toHaveBeenCalledExactlyOnceWith(input);
    expect(open).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });
  it("preserves typed discovery failure without local fallback or retry", async () => {
    const error = new TerminalExecutionTargetError({
      threadId: "t",
      terminalId: "p",
      executionTargetId: "local",
      detail: "Shell inventory unavailable",
    });
    const listShellProfiles = vi.fn(() => Effect.fail(error));
    const context = { terminalManager: { listShellProfiles } } as unknown as WsRpcContext;
    const handler = makeShellProfileHandlers(context)[WS_METHODS.terminalShellProfiles];
    expect(
      await Effect.runPromise(handler({ threadId: "t", terminalId: "p" }).pipe(Effect.flip)),
    ).toBe(error);
    expect(listShellProfiles).toHaveBeenCalledTimes(1);
  });
});
