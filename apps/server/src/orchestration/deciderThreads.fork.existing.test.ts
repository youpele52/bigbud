import { describe, expect, it } from "vitest";

import {
  activity,
  apply,
  decide,
  forkCommand,
  message,
  readModel,
  SOURCE,
  sourceThread,
} from "./deciderThreads.fork.test.helpers.ts";

/** A source that auto-forked for `user-pending` and then failed again for `user-later`. */
async function forkedSource(laterFailureClass: string) {
  const source = sourceThread({
    pairs: 1,
    extraMessages: [message("user-pending", "user", 50), message("user-later", "user", 70)],
    activities: [
      activity("failure-1", "provider.turn.start.failed", 60, { failureClass: "session-dead" }),
      activity("failure-2", "provider.turn.start.failed", 80, { failureClass: laterFailureClass }),
    ],
  });
  const model = readModel(source);
  const automatic = forkCommand({
    reason: "recovery-failed",
    pendingMessageId: "user-pending",
    failureEventId: "failure-1",
  });
  return apply(model, await decide(model, automatic));
}

const carry = forkCommand({
  commandId: "cmd-carry",
  pendingMessageId: "user-later",
  failureEventId: "failure-2",
});
const forkedActivities = (model: Awaited<ReturnType<typeof forkedSource>>) =>
  model.threads
    .find((thread) => thread.id === SOURCE)
    ?.activities.filter((entry) => entry.kind === "thread.forked") ?? [];

describe("thread.fork into the source's existing fork", () => {
  it("carries a never-admitted later message into the existing fork once, when asked", async () => {
    const model = await forkedSource("session-dead");
    const events = await decide(model, carry);
    expect(events.some((event) => event.type === "thread.created")).toBe(false);
    const next = await apply(model, events);
    const fork = next.threads.find((thread) => thread.id === "fork-thread");
    const texts = [
      ...(fork?.messages.map((entry) => entry.text) ?? []),
      ...(fork?.queuedPrompts?.map((prompt) => prompt.text) ?? []),
    ];
    expect(texts.filter((text) => text === "user user-later")).toHaveLength(1);
    expect(fork?.queueHold).toBe(false);
    const lineage = forkedActivities(next).map((entry) => entry.payload);
    expect(lineage).toHaveLength(2);
    expect(lineage).toContainEqual(
      expect.objectContaining({
        forkThreadId: "fork-thread",
        pendingMessageId: "user-later",
        pendingDelivery: "sent",
      }),
    );
    // A redelivered or repeated request carries nothing twice.
    expect(await decide(next, carry)).toEqual([]);
  });

  it("continues in a new fork once the earlier fork for the same message was deleted", async () => {
    const forked = await forkedSource("session-dead");
    const model = {
      ...forked,
      threads: forked.threads.map((thread) =>
        thread.id === "fork-thread"
          ? Object.assign({}, thread, { deletedAt: "2026-10-15T11:00:00.000Z" })
          : thread,
      ),
    };
    const again = forkCommand({
      threadId: "fork-new",
      commandId: "cmd-fork-new",
      pendingMessageId: "user-pending",
      failureEventId: "failure-1",
    });
    const events = await decide(model, again);
    expect(events.find((event) => event.type === "thread.created")?.aggregateId).toBe("fork-new");
    // The deleted fork already received it, so the new fork records that it was sent again.
    const origin = events.find(
      (event) =>
        event.type === "thread.activity-appended" &&
        (event.payload as { activity: { kind: string } }).activity.kind === "thread.fork-origin",
    );
    expect(
      (origin?.payload as { activity: { payload: unknown } } | undefined)?.activity.payload,
    ).toMatchObject({
      pendingDelivery: "sent",
      redelivered: true,
    });
  });

  it("refuses to carry a message that may already have reached the provider", async () => {
    const model = await forkedSource("unsafe-to-replay");
    await expect(decide(model, carry)).rejects.toThrow(/may already have reached/i);
    expect(forkedActivities(model)).toHaveLength(1);
  });
});
