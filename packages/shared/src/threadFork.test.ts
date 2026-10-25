import { describe, expect, it } from "vitest";

import { findLiveAutomaticFork, findOwnTurnStartFailure } from "./threadFork";

const forked = (forkThreadId: string, reason: string, pendingMessageId: string | null) => ({
  kind: "thread.forked",
  payload: { forkThreadId, reason, pendingMessageId },
  createdAt: "2026-10-15T10:00:10.000Z",
});
const user = (id: string) => ({
  id,
  role: "user",
  turnId: null,
  createdAt: "2026-10-15T10:00:00.000Z",
});
const answer = (id: string, createdAt = "2026-10-15T09:00:00.000Z") => ({
  id,
  role: "assistant",
  turnId: "turn-9",
  createdAt,
});

const present = () => true;

describe("findLiveAutomaticFork", () => {
  it("returns the newest automatic fork while the source has not answered since", () => {
    const source = {
      messages: [user("m-1"), user("m-2")],
      activities: [forked("auto-1", "recovery-failed", "m-1"), forked("manual-1", "manual", null)],
    };
    expect(findLiveAutomaticFork(source, present)).toEqual({ forkThreadId: "auto-1" });
  });

  it("ends once the source answers after the forked message (message order, not clocks)", () => {
    // The answer's timestamp is earlier than the fork's; the order still proves the revival.
    const source = {
      messages: [user("m-1"), answer("a-1")],
      activities: [forked("auto-1", "recovery-failed", "m-1")],
    };
    expect(findLiveAutomaticFork(source, present)).toBeNull();
  });

  it("falls back to server timestamps when the forked message is no longer present", () => {
    const activities = [forked("auto-1", "recovery-failed", "gone")];
    expect(
      findLiveAutomaticFork({ messages: [answer("a-1")], activities }, present),
    ).not.toBeNull();
    const later = answer("a-2", "2026-10-15T10:05:00.000Z");
    expect(findLiveAutomaticFork({ messages: [later], activities }, present)).toBeNull();
  });

  it("ignores manual forks", () => {
    const source = { messages: [user("m-1")], activities: [forked("manual-1", "manual", "m-1")] };
    expect(findLiveAutomaticFork(source, present)).toBeNull();
  });

  it("ignores a deleted fork, so the dead source may fork once more", () => {
    const source = {
      messages: [user("m-1")],
      activities: [forked("auto-1", "recovery-failed", "m-1")],
    };
    expect(findLiveAutomaticFork(source, (forkThreadId) => forkThreadId !== "auto-1")).toBeNull();
    expect(findLiveAutomaticFork(source, () => true)).toEqual({ forkThreadId: "auto-1" });
  });
});

const failure = (id: string, createdAt: string, payload: Record<string, unknown>) => ({
  id,
  kind: "provider.turn.start.failed",
  payload,
  createdAt,
});

describe("findOwnTurnStartFailure", () => {
  const messages = [
    { id: "q", role: "user", turnId: null, createdAt: "2026-10-15T10:00:00.000Z" },
    { id: "r", role: "user", turnId: null, createdAt: "2026-10-15T10:01:00.000Z" },
  ];

  it("binds by message id, never to a later message's failure", () => {
    const activities = [
      failure("f-q", "2026-10-15T10:00:00.000Z", {
        failureClass: "unsafe-to-replay",
        messageId: "q",
      }),
      failure("f-r", "2026-10-15T10:01:00.000Z", { failureClass: "session-dead", messageId: "r" }),
    ];
    expect(findOwnTurnStartFailure({ messages, activities }, "q")?.id).toBe("f-q");
    expect(findOwnTurnStartFailure({ messages, activities }, "r")?.id).toBe("f-r");
  });

  it("limits legacy failures without a message id to the window before the next user message", () => {
    const activities = [
      failure("f-q", "2026-10-15T10:00:00.000Z", { failureClass: "unsafe-to-replay" }),
      failure("f-r", "2026-10-15T10:01:00.000Z", { failureClass: "session-dead" }),
    ];
    expect(findOwnTurnStartFailure({ messages, activities }, "q")?.id).toBe("f-q");
    expect(findOwnTurnStartFailure({ messages, activities: activities.slice(1) }, "q")).toBe(
      undefined,
    );
  });
});
