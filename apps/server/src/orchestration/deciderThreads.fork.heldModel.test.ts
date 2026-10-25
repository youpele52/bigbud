import { CommandId, MessageId, ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  activity,
  apply,
  decide,
  forkCommand,
  message,
  NOW,
  readModel,
  sourceThread,
} from "./deciderThreads.fork.test.helpers.ts";

const FORK = ThreadId.makeUnsafe("fork-thread");
const CLAUDE = { provider: "claudeAgent", model: "sonnet" } as const;

const sourceWith = (failureClass: string) =>
  sourceThread({
    pairs: 1,
    extraMessages: [message("user-pending", "user", 50)],
    activities: [
      activity("failure-1", "provider.turn.start.failed", 50, {
        failureClass,
        messageId: "user-pending",
      }),
    ],
  });

const run = (model: Parameters<typeof decide>[0], command: unknown) =>
  decide(model, command as never);

describe("a held message follows the fork's current model selection", () => {
  it("is queued without pinning a model, and the fork stays unstarted and unlocked", async () => {
    const model = readModel(sourceWith("unsafe-to-replay"));
    const forked = await apply(
      model,
      await run(model, forkCommand({ pendingMessageId: "user-pending" })),
    );
    const fork = forked.threads.find((thread) => thread.id === FORK);
    expect(fork?.queueHold).toBe(true);
    expect(fork?.queuedPrompts?.[0]?.modelSelection).toBeUndefined();
    expect(fork?.latestTurn).toBeNull();
    expect(fork?.session).toBeNull();

    // The user picks another provider in the fork's composer, then sends the held message.
    const switched = await apply(
      forked,
      await run(forked, {
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-switch"),
        threadId: FORK,
        modelSelection: CLAUDE,
      }),
    );
    // "Send now": the web persists the picker (the meta.update above), then flushes with the
    // user's release while the hold is still set.
    const held = switched.threads.find((thread) => thread.id === FORK);
    expect(held?.queueHold).toBe(true);
    const released = await run(switched, {
      type: "thread.queued-prompt.flush",
      commandId: CommandId.makeUnsafe("cmd-send-now"),
      threadId: FORK,
      messageIds: [held?.queuedPrompts?.[0]?.id],
      messageId: MessageId.makeUnsafe("send-now"),
      userRelease: true,
      createdAt: NOW,
    });
    const requested = released.find((event) => event.type === "thread.turn-start-requested");
    expect(requested?.payload).toMatchObject({ threadId: FORK });
    expect(
      (requested?.payload as { modelSelection?: unknown } | undefined)?.modelSelection,
    ).toBeUndefined();
    const after = (await apply(switched, released)).threads.find((thread) => thread.id === FORK);
    expect(after?.modelSelection).toEqual(CLAUDE);
    // The turn starts on the picked provider.
    expect(after?.session?.providerName).toBe("claudeAgent");
  });

  it("an immediately sent message still uses the parent thread's model", async () => {
    const model = readModel(sourceWith("session-dead"));
    const events = await run(model, forkCommand({ pendingMessageId: "user-pending" }));
    const requested = events.find((event) => event.type === "thread.turn-start-requested");
    expect(
      (requested?.payload as { modelSelection?: unknown } | undefined)?.modelSelection,
    ).toEqual({
      provider: "codex",
      model: "model-a",
    });
  });
});
