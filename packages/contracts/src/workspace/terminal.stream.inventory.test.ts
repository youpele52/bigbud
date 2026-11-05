import * as Schema from "effect/Schema";
import { expect, it } from "vitest";
import { TerminalEvent } from "./terminal";
import { TerminalEventsStreamItem, TerminalEventsSubscriptionInput } from "./terminal.stream";

it("accepts inventory only as a global subscription control item, including authoritative emptiness", () => {
  const inventory = { type: "inventory", createdAt: "2026-10-29T00:00:00.000Z", sessions: [] };
  expect(Schema.decodeUnknownSync(TerminalEventsStreamItem)(inventory)).toEqual(inventory);
  expect(() => Schema.decodeUnknownSync(TerminalEvent)(inventory)).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(TerminalEventsStreamItem)({ type: "inventory", sessions: [] }),
  ).toThrow();
});

it("keeps inventory opt-in and preserves ordinary event payloads", () => {
  const decode = Schema.decodeUnknownSync(TerminalEventsSubscriptionInput);
  expect(decode({})).toEqual({});
  expect(decode({ outputScope: "legacyDetection", includeInventory: true })).toEqual({
    outputScope: "legacyDetection",
    includeInventory: true,
  });
  const event = {
    type: "activity",
    threadId: "thread",
    terminalId: "terminal",
    createdAt: "2026-10-29T00:00:00.000Z",
    hasRunningSubprocess: true,
  };
  expect(Schema.decodeUnknownSync(TerminalEventsStreamItem)(event)).toEqual(event);
});
