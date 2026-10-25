import { describe, expect, it } from "vitest";

import { deriveServerTurnFailure } from "./ThreadRecoveryNotice.failure";

const user = (id: string, createdAt: string) => ({ id, role: "user", turnId: null, createdAt });
const assistant = (id: string, createdAt: string, turnId: string | null = "turn-1") => ({
  id,
  role: "assistant",
  turnId,
  createdAt,
});
const failure = (id: string, createdAt: string, failureClass?: string) => ({
  id,
  kind: "provider.turn.start.failed",
  payload: failureClass === undefined ? { detail: "x" } : { failureClass },
  createdAt,
});
const derive = (messages: unknown[], activities: unknown[]) =>
  deriveServerTurnFailure({ messages, activities } as never);

describe("deriveServerTurnFailure (server state only)", () => {
  it("returns the latest user message's turn-start failure", () => {
    const messages = [user("m-1", "2026-10-15T10:00:00.000Z")];
    const activities = [failure("f-1", "2026-10-15T10:00:00.000Z", "session-dead")];
    expect(derive(messages, activities)).toEqual({
      pendingMessageId: "m-1",
      failureEventId: "f-1",
      failureClass: "session-dead",
    });
  });

  it("ignores failures that belong to an earlier message", () => {
    const messages = [
      user("m-1", "2026-10-15T10:00:00.000Z"),
      user("m-2", "2026-10-15T10:01:00.000Z"),
    ];
    const activities = [failure("f-1", "2026-10-15T10:00:00.000Z", "session-dead")];
    expect(derive(messages, activities)).toBeNull();
  });

  it("binds by message id: another message's failure never applies", () => {
    const messages = [
      user("m-1", "2026-10-15T10:00:00.000Z"),
      user("m-2", "2026-10-15T10:01:00.000Z"),
    ];
    const late = { ...failure("f-1", "2026-10-15T10:05:00.000Z"), payload: { messageId: "m-1" } };
    expect(
      derive(messages, [{ ...late, payload: { ...late.payload, failureClass: "session-dead" } }]),
    ).toBeNull();
  });

  it("is cleared once a turn started after the message (message order, not clocks)", () => {
    // The assistant row carries the server clock, which is behind the command clock here.
    const messages = [
      user("m-1", "2026-10-15T10:00:00.000Z"),
      assistant("a-1", "2026-10-15T09:00:00.000Z"),
    ];
    const activities = [failure("f-1", "2026-10-15T10:00:00.000Z", "session-dead")];
    expect(derive(messages, activities)).toBeNull();
    const copied = [messages[0], assistant("a-1", "2026-10-15T10:05:00.000Z", null)];
    expect(derive(copied, activities)).not.toBeNull();
  });

  it("reports an unclassified failure with an empty class and nothing without messages", () => {
    const messages = [user("m-1", "2026-10-15T10:00:00.000Z")];
    expect(derive(messages, [failure("f-1", "2026-10-15T10:00:00.000Z")])).toMatchObject({
      failureClass: "",
    });
    expect(derive([], [failure("f-1", "2026-10-15T10:00:00.000Z", "session-dead")])).toBeNull();
  });
});
