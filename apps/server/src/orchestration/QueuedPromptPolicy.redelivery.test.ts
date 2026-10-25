import { CommandId, MessageId } from "@bigbud/contracts/core/baseSchemas.ts";
import { describe, expect, it } from "vitest";

import { now, readModel } from "./deciderThreads.turn.queue.test.helpers.ts";
import { redeliveryQueuePosition } from "./QueuedPromptPolicy.logic.ts";

const queued = (id: string, alreadySent?: boolean) => ({
  id: MessageId.makeUnsafe(id),
  text: id,
  createdAt: now,
  ...(alreadySent ? { alreadySent } : {}),
});

describe("redeliveryQueuePosition", () => {
  it("puts a refused message ahead of prompts queued after it", () => {
    const thread = readModel({ queuedPrompts: [queued("c"), queued("d")] }).threads[0]!;
    expect(redeliveryQueuePosition(thread)).toBe(1);
  });

  it("keeps earlier redeliveries first", () => {
    const thread = readModel({ queuedPrompts: [queued("x", true), queued("c")] }).threads[0]!;
    expect(redeliveryQueuePosition(thread)).toBe(2);
  });

  it("never splits a prefix an interrupt already captured", () => {
    const thread = readModel({
      queuedPrompts: [queued("a"), queued("b"), queued("c")],
      pendingInterruptFlushIntent: {
        intentId: CommandId.makeUnsafe("send-now"),
        queuedPromptIds: [MessageId.makeUnsafe("a"), MessageId.makeUnsafe("b")],
        requestedAt: now,
      },
    }).threads[0]!;
    expect(redeliveryQueuePosition(thread)).toBe(3);
  });
});
