import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ThreadTurnStartFailedPayload } from "./orchestration.events.thread";
import { OrchestrationCommand } from "./orchestration.commands";

const base = {
  threadId: "thread-1",
  context: "provider-turn-start",
  detail: "Provider session closed.",
  createdAt: "2026-10-15T10:00:00.000Z",
};

describe("turn-start failure classification on the wire", () => {
  it("decodes events written before classification existed", () => {
    const decoded = Schema.decodeUnknownSync(ThreadTurnStartFailedPayload)(base);
    expect(decoded.failureClass).toBeUndefined();
  });

  it("round-trips a classified failure event and command", () => {
    const event = Schema.decodeUnknownSync(ThreadTurnStartFailedPayload)({
      ...base,
      failureClass: "session-dead",
    });
    expect(event.failureClass).toBe("session-dead");
    const command = Schema.decodeUnknownSync(OrchestrationCommand)({
      ...base,
      type: "thread.turn.start.failed",
      commandId: "server:provider-turn-start-failed:1",
      failureClass: "auth-or-quota",
    });
    expect(command).toMatchObject({ failureClass: "auth-or-quota" });
  });

  it("accepts provider-unavailable (missing binary or disabled provider)", () => {
    const event = Schema.decodeUnknownSync(ThreadTurnStartFailedPayload)({
      ...base,
      failureClass: "provider-unavailable",
    });
    expect(event.failureClass).toBe("provider-unavailable");
  });

  it("rejects unknown classes", () => {
    expect(() =>
      Schema.decodeUnknownSync(ThreadTurnStartFailedPayload)({ ...base, failureClass: "flaky" }),
    ).toThrow();
  });
});
