import { CommandId, MessageId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { decideThreadSessionCommand } from "./deciderThreads.turn.session.ts";
import { decideThreadQueueCommand } from "./deciderThreads.turn.queue.ts";
import {
  model,
  now,
  operation,
  prompt,
  thread,
  threadId,
  turnId,
} from "./QueuedPromptPolicy.test.helpers.ts";

const flush = {
  type: "thread.queued-prompt.flush" as const,
  commandId: CommandId.makeUnsafe("flush"),
  threadId,
  messageIds: [prompt("one").id],
  messageId: MessageId.makeUnsafe("combined"),
  controlOperationId: operation().operationId,
  acknowledged: true,
  consumeOnly: true,
  createdAt: now,
};

describe("queued control prefix ownership", () => {
  it.each(["steer", "interrupt"] as const)(
    "reserves only a compatible prefix for %s",
    async (action) => {
      const ids = [prompt("one").id, prompt("two").id];
      const events = await Effect.runPromise(
        decideThreadSessionCommand({
          command:
            action === "steer"
              ? {
                  type: "thread.turn.steer",
                  commandId: CommandId.makeUnsafe("steer"),
                  threadId,
                  turnId,
                  queuedPromptIds: ids,
                  createdAt: now,
                }
              : {
                  type: "thread.turn.interrupt",
                  commandId: CommandId.makeUnsafe("interrupt"),
                  threadId,
                  turnId,
                  queuedPromptIdsAfterSettlement: ids,
                  createdAt: now,
                },
          readModel: model(
            thread({
              queuedPrompts: [prompt("one"), { ...prompt("two"), runtimeMode: "full-access" }],
            }),
          ),
        }),
      );
      expect(events).toMatchObject({ payload: { operation: { reservedPromptIds: [ids[0]] } } });
      if (action === "interrupt")
        expect(events).toMatchObject({
          payload: { pendingFlushIntent: { queuedPromptIds: [ids[0]] } },
        });
    },
  );

  it.each([
    operation({ state: "ambiguous", strategy: "native-steer" }),
    operation({ state: "requested", strategy: "native-steer" }),
    operation({ state: "provider-acknowledged", strategy: "native-steer", sessionEpoch: 0 }),
    operation({
      state: "provider-acknowledged",
      strategy: "native-steer",
      reservedPromptIds: [prompt("one").id, prompt("two").id],
    }),
    operation({ state: "completed", strategy: "native-steer" }),
  ])("does not consume invalid control state %#", async (pendingTurnControlOperation) => {
    expect(
      await Effect.runPromise(
        decideThreadQueueCommand({
          command: flush,
          readModel: model(thread({ pendingTurnControlOperation })),
        }),
      ),
    ).toEqual([]);
  });

  it("consumes exactly an acknowledged native reservation", async () => {
    expect(
      await Effect.runPromise(
        decideThreadQueueCommand({
          command: flush,
          readModel: model(
            thread({
              pendingTurnControlOperation: operation({
                state: "provider-acknowledged",
                strategy: "native-steer",
              }),
            }),
          ),
        }),
      ),
    ).toMatchObject({
      type: "thread.queued-prompts-flushed",
      payload: { messageIds: flush.messageIds },
    });
  });

  it("does not allow interrupt acknowledgement to start over an active turn", async () => {
    expect(
      await Effect.runPromise(
        decideThreadQueueCommand({
          command: { ...flush, consumeOnly: false },
          readModel: model(
            thread({
              pendingTurnControlOperation: operation({
                state: "waiting-for-settlement",
                strategy: "interrupt-continue",
              }),
            }),
          ),
        }),
      ),
    ).toEqual([]);
  });

  it("keeps the five-prompt cap including reserved prompts", async () => {
    await expect(
      Effect.runPromise(
        decideThreadQueueCommand({
          command: {
            type: "thread.message.submit",
            commandId: CommandId.makeUnsafe("six"),
            threadId,
            message: { messageId: MessageId.makeUnsafe("six"), text: "six" },
            delivery: "auto",
            createdAt: now,
          },
          readModel: model(
            thread({
              queuedPrompts: ["one", "two", "three", "four", "five"].map(prompt),
              pendingTurnControlOperation: operation({
                state: "ambiguous",
                strategy: "native-steer",
              }),
            }),
          ),
        }),
      ),
    ).rejects.toThrow("at most 5 prompts");
  });
});
