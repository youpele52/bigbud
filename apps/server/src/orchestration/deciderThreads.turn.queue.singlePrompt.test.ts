import { CommandId, MessageId, type OrchestrationEvent } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideThreadQueueCommand } from "./deciderThreads.turn.queue.ts";
import { now, readModel, threadId } from "./deciderThreads.turn.queue.test.helpers.ts";

type Events = ReadonlyArray<Omit<OrchestrationEvent, "sequence">>;

const origin = {
  kind: "ordinaryUser" as const,
  actor: "user" as const,
  text: "Only one",
  sourceThreads: [],
  verified: true,
};

const queued = (id: string, text: string) => ({
  id: MessageId.makeUnsafe(id),
  text,
  createdAt: now,
});

const flush = (messageIds: ReadonlyArray<string>) => ({
  type: "thread.queued-prompt.flush" as const,
  commandId: CommandId.makeUnsafe("flush"),
  threadId,
  messageIds: messageIds.map((id) => MessageId.makeUnsafe(id)),
  messageId: MessageId.makeUnsafe("queue-message:digest"),
  createdAt: now,
});

const sentMessage = (events: unknown) =>
  (events as Events).find(
    (event): event is Extract<OrchestrationEvent, { type: "thread.message-sent" }> =>
      event.type === "thread.message-sent",
  )?.payload;

describe("single-prompt queue flush", () => {
  it("keeps the prompt's own ID, plain text, and attribution", async () => {
    const events = await Effect.runPromise(
      decideThreadQueueCommand({
        command: flush(["only"]),
        readModel: readModel({
          queuedPrompts: [{ ...queued("only", "Only one"), originSegments: [origin] }],
        }),
      }),
    );
    expect(sentMessage(events)).toMatchObject({
      messageId: "only",
      text: "Only one",
      originSegments: [origin],
    });
  });

  it("still combines several prompts under the flush message ID", async () => {
    const events = await Effect.runPromise(
      decideThreadQueueCommand({
        command: flush(["one", "two"]),
        readModel: readModel({ queuedPrompts: [queued("one", "one"), queued("two", "two")] }),
      }),
    );
    expect(sentMessage(events)).toMatchObject({
      messageId: "queue-message:digest",
      text: "Additional instructions:\n- one\n- two",
    });
  });

  it("starts a lone auto-flushed prompt under its own ID", async () => {
    const events = await Effect.runPromise(
      decideThreadQueueCommand({
        command: {
          type: "thread.message.submit",
          commandId: CommandId.makeUnsafe("submit"),
          threadId,
          message: { messageId: MessageId.makeUnsafe("with-file"), text: "See file" },
          titleSeed: "Seeded",
          delivery: "auto",
          createdAt: now,
        },
        readModel: readModel({ queuedPrompts: [queued("first", "First")] }),
      }),
    );
    expect(sentMessage(events)).toMatchObject({ messageId: "first", text: "First" });
  });
});
