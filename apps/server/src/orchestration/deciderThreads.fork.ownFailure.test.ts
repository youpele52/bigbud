import { describe, expect, it } from "vitest";

import {
  activity,
  apply,
  decide,
  forkCommand,
  message,
  readModel,
  sourceThread,
} from "./deciderThreads.fork.test.helpers.ts";

/**
 * Q failed `unsafe-to-replay` (it may have reached the provider), then R failed `session-dead`.
 * A stale tab still asks to continue with Q: Q must stay held, never be resent.
 */
function source(bound: boolean) {
  const failure = (id: string, index: number, failureClass: string, messageId: string) =>
    activity(id, "provider.turn.start.failed", index, {
      failureClass,
      ...(bound ? { messageId } : {}),
    });
  return sourceThread({
    pairs: 1,
    extraMessages: [message("user-q", "user", 50), message("user-r", "user", 70)],
    activities: [
      failure("failure-q", 50, "unsafe-to-replay", "user-q"),
      failure("failure-r", 70, "session-dead", "user-r"),
    ],
  });
}

const forkedQ = (events: Awaited<ReturnType<typeof decide>>) =>
  events.find(
    (event) => event.type === "thread.activity-appended" && event.aggregateId === "source-thread",
  )?.payload as { activity: { payload: { pendingDelivery: string | null } } } | undefined;

describe("thread.fork pending delivery uses the message's own failure", () => {
  it.each([
    ["bound by message id", true],
    ["legacy activities without a message id", false],
  ])("holds Q although a later message failed session-dead (%s)", async (_label, bound) => {
    const events = await decide(
      readModel(source(bound)),
      forkCommand({ pendingMessageId: "user-q", failureEventId: "failure-q" }),
    );
    expect(events.some((event) => event.type === "thread.turn-start-requested")).toBe(false);
    expect(forkedQ(events)?.activity.payload.pendingDelivery).toBe("held");
  });

  it("refuses to carry Q into an existing fork", async () => {
    const model = readModel(source(true));
    const automatic = forkCommand({
      reason: "recovery-failed",
      pendingMessageId: "user-r",
      failureEventId: "failure-r",
    });
    const forked = await apply(model, await decide(model, automatic));
    const carryQ = forkCommand({
      commandId: "cmd-carry-q",
      pendingMessageId: "user-q",
      failureEventId: "failure-q",
    });
    await expect(decide(forked, carryQ)).rejects.toThrow(/may already have reached/i);
  });
});
