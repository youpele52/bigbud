import { CommandId, MessageId, type OrchestrationCommand } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { makeResolvedActivity } from "./deciderThreads.delegationModelChoice.logic.ts";
import {
  alternative,
  apply,
  baseReadModel,
  choiceId,
  decide,
  fallback,
  heldMessageId,
  heldReadModel,
  holdCommand,
  now,
  pickCommand,
  requestedPayload,
} from "./deciderThreads.delegationModelChoice.test.helpers.ts";

const resolvedFallback = (cancelled = false) =>
  makeResolvedActivity(
    {
      choiceId,
      requested: requestedPayload.requested,
      fallback,
      reason: requestedPayload.reason,
      used: fallback,
      outcome: "fallback",
      resolvedBy: "server",
      ...(cancelled ? { cancelled: true } : {}),
    },
    now,
  );

const withActivity = (activity: ReturnType<typeof makeResolvedActivity>) => {
  const readModel = baseReadModel();
  return {
    ...readModel,
    threads: [{ ...readModel.threads[0]!, activities: [activity] }],
  };
};

describe("delegated model choice retries (M2)", () => {
  it("rejects a retried hold when the fallback was recorded but no message exists", async () => {
    // The first attempt's hold failed, the fallback was recorded, and its turn start failed.
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: holdCommand(),
          readModel: withActivity(resolvedFallback()),
        }),
      ),
    ).rejects.toThrow(/no delegated message/);
  });

  it("treats the hold as done when it is pending, cancelled, or its message exists", async () => {
    expect(await decide(await heldReadModel(), holdCommand())).toEqual([]);
    expect(await decide(withActivity(resolvedFallback(true)), holdCommand())).toEqual([]);
    const sent = withActivity(resolvedFallback());
    const thread = sent.threads[0]!;
    const withMessage = {
      ...sent,
      threads: [{ ...thread, messages: [{ id: heldMessageId } as never] }],
    };
    expect(await decide(withMessage, holdCommand())).toEqual([]);
  });
});

describe("a pick while another blocker holds the queue (L7)", () => {
  it("later flushes the held message with the picked model, not the fallback", async () => {
    const held = await heldReadModel();
    const starting = {
      ...held,
      threads: [
        {
          ...held.threads[0]!,
          session: { threadId: held.threads[0]!.id, status: "starting" } as never,
        },
      ],
    };
    const picked = await apply(starting, await decide(starting, pickCommand(alternative)));
    expect(picked.threads[0]?.queuedPrompts?.map((prompt) => prompt.id)).toEqual([heldMessageId]);

    const idle = { ...picked, threads: [{ ...picked.threads[0]!, session: null }] };
    const flush: OrchestrationCommand = {
      type: "thread.queued-prompt.flush",
      commandId: CommandId.makeUnsafe("cmd-flush-after-pick"),
      threadId: idle.threads[0]!.id,
      messageIds: [heldMessageId],
      messageId: MessageId.makeUnsafe("flush-message"),
      createdAt: "2026-10-15T10:00:06.000Z",
    };
    const events = await decide(idle, flush);
    const requested = events.find((event) => event.type === "thread.turn-start-requested");
    expect(requested?.payload).toMatchObject({ modelSelection: alternative });
  });
});
