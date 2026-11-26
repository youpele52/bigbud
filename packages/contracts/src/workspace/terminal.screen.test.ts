import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  TerminalScreenItem,
  TerminalSessionInventory,
  TerminalSessionStreamInput,
  TerminalSessionStreamItem,
  TerminalSessionStreamRpcItem,
} from "./terminal.stream";
import { TERMINAL_RECOVERY_TAIL_MAX_CHARS } from "./terminal.recovery";

const screen = {
  type: "screen",
  threadId: "thread",
  terminalId: "pane",
  runtimeGeneration: "run-1",
  throughSequence: "18446744073709551615",
  cols: 120,
  rows: 40,
  ansi: "\u001b[1mhello\u001b[0m",
  pendingEscapeTail: "",
  scrollbackRows: 1000,
  alternateScreen: false,
  fidelity: "full",
  cold: false,
};

describe("terminal screen items", () => {
  it("decodes a host screen whose 64-bit sequence survives JSON as a decimal string", () => {
    expect(Schema.decodeUnknownSync(TerminalScreenItem)(screen)).toEqual(screen);
    for (const throughSequence of ["", "-1", "01", "1.5", "1e3", "1".repeat(21)]) {
      expect(() =>
        Schema.decodeUnknownSync(TerminalScreenItem)({ ...screen, throughSequence }),
      ).toThrow();
    }
    expect(
      Schema.decodeUnknownSync(TerminalScreenItem)({ ...screen, throughSequence: "0" }),
    ).toEqual({ ...screen, throughSequence: "0" });
  });

  it("bounds the pending escape tail and the geometry, and names the fidelity", () => {
    const decode = Schema.decodeUnknownSync(TerminalScreenItem);
    const tail = "x".repeat(TERMINAL_RECOVERY_TAIL_MAX_CHARS);
    expect(decode({ ...screen, pendingEscapeTail: tail }).pendingEscapeTail).toBe(tail);
    expect(() => decode({ ...screen, pendingEscapeTail: `${tail}x` })).toThrow();
    expect(() => decode({ ...screen, cols: 0 })).toThrow();
    expect(() => decode({ ...screen, rows: 501 })).toThrow();
    expect(() => decode({ ...screen, fidelity: "lossy" })).toThrow();
    expect(decode({ ...screen, fidelity: "trimmed", cold: true })).toMatchObject({ cold: true });
  });

  it("carries screens on the session RPC only, never to legacy stream consumers", () => {
    expect(Schema.decodeUnknownSync(TerminalSessionStreamRpcItem)(screen)).toEqual(screen);
    expect(() => Schema.decodeUnknownSync(TerminalSessionStreamItem)(screen)).toThrow();
    const subscribed = { type: "subscribed", subscriptionId: "sub-1" };
    expect(Schema.decodeUnknownSync(TerminalSessionStreamRpcItem)(subscribed)).toEqual(subscribed);
  });

  it("keeps screens opt-in on the session subscription", () => {
    const decode = Schema.decodeUnknownSync(TerminalSessionStreamInput);
    expect(decode({ threadId: "thread", terminalId: "pane" }).acceptScreen).toBeUndefined();
    expect(
      decode({ threadId: "thread", terminalId: "pane", acceptScreen: true }).acceptScreen,
    ).toBe(true);
  });

  it("adds optional activity, restorability and idle deadlines to inventory sessions", () => {
    const inventory = {
      type: "inventory",
      createdAt: "2026-11-21T10:00:00.000Z",
      sessions: [
        { threadId: "a", terminalId: "1" },
        {
          threadId: "b",
          terminalId: "2",
          activity: "busy",
          restorable: true,
          idleClosesAt: "2026-11-21T10:10:00.000Z",
        },
      ],
    };
    expect(Schema.decodeUnknownSync(TerminalSessionInventory)(inventory)).toEqual(inventory);
    expect(() =>
      Schema.decodeUnknownSync(TerminalSessionInventory)({
        ...inventory,
        sessions: [{ threadId: "a", terminalId: "1", activity: "idle" }],
      }),
    ).toThrow();
  });
});
