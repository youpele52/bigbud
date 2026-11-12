import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { TerminalError, TerminalExecutionTargetError } from "./terminal";

const base = {
  _tag: "TerminalExecutionTargetError",
  threadId: "thread",
  terminalId: "pane",
  executionTargetId: "local",
  detail: "Profile unavailable",
} as const;

describe("terminal restart refusal evidence", () => {
  it("preserves optional typed evidence through the terminal error codec", () => {
    for (const reason of [
      undefined,
      "staleGeneration",
      "restartNotStarted",
      "directShellUnconfirmed",
    ] as const) {
      const input = { ...base, ...(reason ? { reason } : {}) };
      const decoded = Schema.decodeUnknownSync(TerminalError)(input);
      expect(decoded).toBeInstanceOf(TerminalExecutionTargetError);
      expect(Schema.encodeSync(TerminalError)(decoded)).toEqual(input);
    }
  });

  it("does not infer evidence from text or admit unknown evidence values", () => {
    const decoded = Schema.decodeUnknownSync(TerminalExecutionTargetError)({
      ...base,
      detail: "no replacement was started",
    });
    expect(decoded.reason).toBeUndefined();
    expect(Schema.is(TerminalError)({ ...base, reason: "notStartedProbably" })).toBe(false);
  });
});
