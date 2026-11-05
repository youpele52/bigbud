import * as Schema from "effect/Schema";
import { expect, it } from "vitest";
import {
  TerminalRecoveryInput,
  TerminalRecoveryResult,
  TERMINAL_RECOVERY_ANSI_MAX_CHARS,
  TERMINAL_RECOVERY_TAIL_MAX_CHARS,
} from "./terminal.recovery";

it("requires generation-bound requests and safe integer cuts", () => {
  const decode = Schema.decodeUnknownSync(TerminalRecoveryInput);
  const input = { threadId: "thread", terminalId: "default", expectedGeneration: "generation" };
  expect(decode(input)).toEqual(input);
  expect(() => decode({ threadId: "thread", terminalId: "default" })).toThrow();
  for (const sequence of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
    expect(() => decode({ ...input, after: { generation: "generation", sequence } })).toThrow();
});

it("bounds snapshot geometry, parser tail and ANSI payload", () => {
  const decode = Schema.decodeUnknownSync(TerminalRecoveryResult);
  const frame = {
    generation: "generation",
    sequence: 1,
    cols: 80,
    rows: 24,
    ansi: "frame",
    pendingEscapeTail: "",
    scrollbackRows: 1000,
  };
  expect(decode({ type: "snapshot", frame })).toEqual({ type: "snapshot", frame });
  for (const patch of [
    { cols: 1001 },
    { rows: 501 },
    { ansi: "x".repeat(1048577) },
    { pendingEscapeTail: "x".repeat(16385) },
  ])
    expect(() => decode({ type: "snapshot", frame: { ...frame, ...patch } })).toThrow();
});

it("keeps unavailable and snapshot-required distinct from process death", () => {
  const decode = Schema.decodeUnknownSync(TerminalRecoveryResult);
  expect(decode({ type: "unavailable", reason: "pending-renderer-query" })).toEqual({
    type: "unavailable",
    reason: "pending-renderer-query",
  });
  expect(
    decode({ type: "snapshot-required", through: { generation: "generation", sequence: 4 } }).type,
  ).toBe("snapshot-required");
});

it("accepts the exact UTF-16 ceiling and bounds worst-case JSON escaping separately", () => {
  const value = {
    type: "snapshot",
    frame: {
      generation: "g",
      sequence: 1,
      cols: 80,
      rows: 24,
      scrollbackRows: 0,
      ansi: "\x1b".repeat(TERMINAL_RECOVERY_ANSI_MAX_CHARS),
      pendingEscapeTail: "\x1b".repeat(TERMINAL_RECOVERY_TAIL_MAX_CHARS),
    },
  };
  const decoded = Schema.decodeUnknownSync(TerminalRecoveryResult)(value);
  const wireBytes = new TextEncoder().encode(JSON.stringify(decoded)).length;
  expect(wireBytes).toBeGreaterThan(2 * 1024 * 1024);
  expect(wireBytes).toBeLessThan(
    6 * (TERMINAL_RECOVERY_ANSI_MAX_CHARS + TERMINAL_RECOVERY_TAIL_MAX_CHARS) + 1024,
  );
  expect(() =>
    Schema.decodeUnknownSync(TerminalRecoveryResult)({
      ...value,
      frame: { ...value.frame, ansi: value.frame.ansi + "x" },
    }),
  ).toThrow();
});
