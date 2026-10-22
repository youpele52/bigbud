import { EventId, MessageId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import { Cause, Effect } from "effect";
import { describe, expect, it } from "vitest";

import { now, readModel, threadId } from "../deciderThreads.turn.queue.test.helpers.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { failUnhandledTurnStart } from "./ProviderCommandReactor.turnStartBackstop.ts";

const messageId = MessageId.makeUnsafe("message-ab");

const event = {
  sequence: 12,
  eventId: EventId.makeUnsafe("turn-start-requested-ab"),
  type: "thread.turn-start-requested",
  aggregateKind: "thread",
  aggregateId: threadId,
  occurredAt: now,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  payload: {
    threadId,
    messageId,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: now,
  },
} as unknown as Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>;

function engineWith(pendingMessageId: string | null) {
  const dispatched: OrchestrationCommand[] = [];
  const model = readModel({
    pendingTurnStart:
      pendingMessageId === null
        ? null
        : { messageId: MessageId.makeUnsafe(pendingMessageId), requestedAt: now },
  });
  const engine = {
    getReadModel: () => Effect.succeed(model),
    dispatch: (command: OrchestrationCommand) =>
      Effect.sync(() => {
        dispatched.push(command);
        return { sequence: dispatched.length };
      }),
  } as unknown as OrchestrationEngineShape;
  return { engine, dispatched };
}

const run = (engine: OrchestrationEngineShape) =>
  Effect.runPromise(
    failUnhandledTurnStart({
      orchestrationEngine: engine,
      event,
      cause: Cause.fail(new Error("context expansion failed")),
    }),
  );

describe("unhandled turn start backstop", () => {
  it("fails a start that threw before reaching the provider, clearing its gate", async () => {
    const { engine, dispatched } = engineWith("message-ab");
    await run(engine);
    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.turn.start.failed",
      "thread.activity.append",
    ]);
    expect(dispatched[0]).toMatchObject({
      context: "provider-turn-start",
      failureClass: "unknown",
    });
  });

  it.each([null, "newer-message"])(
    "leaves the thread alone once the start bound or moved on (gate %s)",
    async (pending) => {
      const { engine, dispatched } = engineWith(pending);
      await run(engine);
      expect(dispatched).toEqual([]);
    },
  );
});
