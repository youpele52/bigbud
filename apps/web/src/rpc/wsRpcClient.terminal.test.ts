import { expect, it, vi } from "vitest";
import { WS_METHODS } from "@bigbud/contracts";
import type { TerminalEventsStreamItem } from "@bigbud/contracts/workspace/terminal.stream.ts";
import { createTerminalRpcClient } from "./wsRpcClient.terminal";
import type { WsTransport } from "./wsTransport";

it("requests shell profiles through the read-only pane endpoint exactly once", async () => {
  const input = { threadId: "thread", terminalId: "pane" };
  const inventory = { host: { kind: "local", hostId: "local" }, profiles: [] };
  const request = vi.fn(async () => inventory);
  const transport = {
    request: vi.fn((connect: (client: unknown) => unknown) =>
      connect({ [WS_METHODS.terminalShellProfiles]: request }),
    ),
  } as unknown as WsTransport;
  await expect(createTerminalRpcClient(transport).shellProfiles(input)).resolves.toEqual(inventory);
  expect(request).toHaveBeenCalledExactlyOnceWith(input);
  expect(transport.request).toHaveBeenCalledTimes(1);
});

it("opts in only with an inventory consumer and separates control items from terminal events", () => {
  let deliver!: (item: TerminalEventsStreamItem) => void;
  const subscribeRpc = vi.fn();
  const unsubscribe = vi.fn();
  const transport = {
    subscribe: vi.fn(
      (
        connect: (client: unknown) => unknown,
        listener: (item: TerminalEventsStreamItem) => void,
      ) => {
        connect({ [WS_METHODS.subscribeTerminalEvents]: subscribeRpc });
        deliver = listener;
        return unsubscribe;
      },
    ),
  } as unknown as WsTransport;
  const client = createTerminalRpcClient(transport);
  const event = {
    type: "activity" as const,
    threadId: "t",
    terminalId: "a",
    createdAt: "2026-10-29",
    hasRunningSubprocess: true,
  };
  const inventory = { type: "inventory" as const, createdAt: "2026-10-29", sessions: [] };
  const listener = vi.fn();
  const onInventory = vi.fn();
  expect(client.onEvent(listener, { onInventory })).toBe(unsubscribe);
  expect(subscribeRpc).toHaveBeenLastCalledWith({
    outputScope: "legacyDetection",
    includeInventory: true,
  });
  deliver(inventory);
  deliver(event);
  expect(onInventory).toHaveBeenCalledExactlyOnceWith(inventory);
  expect(listener).toHaveBeenCalledExactlyOnceWith(event);

  client.onEvent(listener);
  expect(subscribeRpc).toHaveBeenLastCalledWith({ outputScope: "legacyDetection" });
  deliver(inventory);
  expect(listener).toHaveBeenCalledOnce();
});
