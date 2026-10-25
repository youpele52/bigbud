import { MessageId, type OrchestrationEvent, ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ThreadRecoveryIntentRepositoryLive } from "../../persistence/Layers/ThreadRecoveryIntents.ts";
import { ThreadRecoveryIntentRepository } from "../../persistence/Services/ThreadRecoveryIntents.ts";
import { recordRecoveryIntentForEvent } from "./OrchestrationEngine.recoveryIntents.ts";

const layer = ThreadRecoveryIntentRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const at = "2026-10-22T10:00:00.000Z";
const messageId = MessageId.makeUnsafe("cut-turn");

/** A cut turn whose recovery already started, as the coordinator leaves it. */
const seedRecovering = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const intents = yield* ThreadRecoveryIntentRepository;
    yield* intents.recordAccepted({ threadId, messageId, provider: "codex", createdAt: at });
    yield* intents.transition({
      key: { threadId, messageId },
      expectedRevision: 0,
      patch: { recoveryStatus: "awaiting-user" },
      at,
    });
    return intents;
  });

const promptQueued = (threadId: ThreadId, alreadySent: boolean) =>
  ({
    type: "thread.prompt-queued",
    occurredAt: at,
    payload: {
      threadId,
      prompt: { id: MessageId.makeUnsafe("queued"), text: "next", alreadySent },
    },
  }) as unknown as OrchestrationEvent;

it.layer(layer)("a queued prompt and sleep recovery", (it) => {
  it.effect("a prompt the user queued after the cut settles the recovering intent", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.makeUnsafe("prompt-queued-user");
      const intents = yield* seedRecovering(threadId);
      yield* recordRecoveryIntentForEvent(intents, promptQueued(threadId, false));
      const intent = Option.getOrThrow(yield* intents.get({ threadId, messageId }));
      assert.strictEqual(intent.disposition, "settled");
    }),
  );

  it.effect("a busy refusal re-queuing an already-sent message is not user activity", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.makeUnsafe("prompt-queued-already-sent");
      const intents = yield* seedRecovering(threadId);
      yield* recordRecoveryIntentForEvent(intents, promptQueued(threadId, true));
      const intent = Option.getOrThrow(yield* intents.get({ threadId, messageId }));
      assert.strictEqual(intent.disposition, "active");
      assert.strictEqual(intent.recoveryStatus, "awaiting-user");
    }),
  );
});
