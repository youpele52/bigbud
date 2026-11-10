import { CommandId, EventId, MessageId, ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const now = "2026-11-10T12:00:00.000Z";
const thread = ThreadId.makeUnsafe("proof-thread");
const otherThread = ThreadId.makeUnsafe("proof-other-thread");
let counter = 0;

const base = (threadId: ThreadId) => {
  counter += 1;
  return {
    eventId: EventId.makeUnsafe(`evt-proof-${counter}`),
    aggregateKind: "thread" as const,
    aggregateId: threadId,
    occurredAt: now,
    commandId: CommandId.makeUnsafe(`cmd-proof-${counter}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
  };
};

const message = (threadId: ThreadId, role: "user" | "assistant", text: string) => ({
  ...base(threadId),
  type: "thread.message-sent" as const,
  payload: {
    threadId,
    messageId: MessageId.makeUnsafe(`message-proof-${counter}`),
    role,
    text,
    turnId: null,
    streaming: role === "assistant",
    createdAt: now,
    updatedAt: now,
  },
});

const queued = (threadId: ThreadId, text: string) => ({
  ...base(threadId),
  type: "thread.prompt-queued" as const,
  payload: {
    threadId,
    prompt: { id: MessageId.makeUnsafe(`queued-proof-${counter}`), text, createdAt: now },
    queuePosition: 1,
  },
});

const activity = (threadId: ThreadId, kind: string) => ({
  ...base(threadId),
  type: "thread.activity-appended" as const,
  payload: {
    threadId,
    activity: {
      id: EventId.makeUnsafe(`activity-proof-${counter}`),
      tone: "info" as const,
      kind,
      summary: kind,
      payload: { requestId: `request-${counter}` },
      turnId: null,
      createdAt: now,
    },
  },
});

layer("OrchestrationEventStore thread proof events", (it) => {
  it.effect("pages one thread's user-role candidates after a sequence, past assistant chunks", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const append = (event: Parameters<typeof eventStore.append>[0]) => eventStore.append(event);
      const first = yield* append(message(thread, "user", "first"));
      for (let index = 0; index < 5; index += 1) {
        yield* append(message(thread, "assistant", `chunk ${index}`));
      }
      yield* append(message(otherThread, "user", "elsewhere"));
      const second = yield* append(message(thread, "user", "second"));
      yield* append(activity(thread, "tool.progress"));
      yield* append(activity(thread, "user-input.resolved"));
      const asked = yield* append(activity(thread, "user-input.requested"));
      const third = yield* append(queued(thread, "third"));
      const otherLast = yield* append(message(otherThread, "assistant", "late"));

      const page = yield* eventStore.readThreadProofEventsAfter!({
        threadId: thread,
        afterSequence: 0,
        limit: 2,
      });
      assert.deepStrictEqual(
        page.map((event) => event.sequence),
        [first.sequence, second.sequence],
      );
      const next = yield* eventStore.readThreadProofEventsAfter!({
        threadId: thread,
        afterSequence: second.sequence,
        limit: 3,
      });
      // `$.activity.kind` keeps only question activities among appended activities.
      assert.deepStrictEqual(
        next.map((event) => event.sequence),
        [asked.sequence, third.sequence],
      );
      assert.strictEqual(yield* eventStore.readThreadMaxSequence!(thread), third.sequence);
      assert.strictEqual(yield* eventStore.readThreadMaxSequence!(otherThread), otherLast.sequence);
      assert.strictEqual(
        yield* eventStore.readThreadMaxSequence!(ThreadId.makeUnsafe("no-events")),
        0,
      );

      const queryPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT sequence FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ${thread} AND sequence > ${0}
        ORDER BY sequence ASC
      `;
      assert.ok(queryPlan.some((row) => row.detail.includes("idx_orch_events_stream_sequence")));
    }),
  );

  it.effect("reads one thread's latest user-turn events, newest window first, in order", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const append = (event: Parameters<typeof eventStore.append>[0]) => eventStore.append(event);
      const userTurnThread = ThreadId.makeUnsafe("user-turn-thread");
      const old = yield* append(message(userTurnThread, "user", "old"));
      const prompt = yield* append(queued(userTurnThread, "queued"));
      const flushed = yield* append({
        ...base(userTurnThread),
        type: "thread.queued-prompts-flushed" as const,
        payload: { threadId: userTurnThread, messageIds: [MessageId.makeUnsafe("queued-x")] },
      });
      const latest = yield* append(message(userTurnThread, "user", "latest"));
      const started = yield* append({
        ...base(userTurnThread),
        type: "thread.turn-start-requested" as const,
        payload: {
          threadId: userTurnThread,
          messageId: MessageId.makeUnsafe("message-latest"),
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          createdAt: now,
        },
      });
      yield* append(message(userTurnThread, "assistant", "reply"));
      yield* append(activity(userTurnThread, "user-input.requested"));
      yield* append(message(otherThread, "user", "elsewhere"));

      const all = yield* eventStore.readThreadRecentUserTurnEvents!({
        threadId: userTurnThread,
        limit: 10,
      });
      // Assistant chunks and activities never take a slot in the window.
      assert.deepStrictEqual(
        all.map((event) => event.sequence),
        [old.sequence, prompt.sequence, flushed.sequence, latest.sequence, started.sequence],
      );
      const tail = yield* eventStore.readThreadRecentUserTurnEvents!({
        threadId: userTurnThread,
        limit: 2,
      });
      assert.deepStrictEqual(
        tail.map((event) => event.sequence),
        [latest.sequence, started.sequence],
      );
    }),
  );
});
