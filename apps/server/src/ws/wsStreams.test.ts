import {
  EventId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
  ServerSettingsError,
} from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { assertTrue } from "@effect/vitest/utils";
import { Effect, Option, PubSub, Stream } from "effect";

import {
  makeOrderedOrchestrationDomainEventStream,
  makeThinkingActivityDeltaStream,
} from "./wsStreams.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-ws-streams-test");
const TURN_ID = TurnId.makeUnsafe("turn-ws-streams-test");

function makeEvent(sequence: number): OrchestrationEvent {
  return {
    sequence,
    eventId: EventId.makeUnsafe(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    occurredAt: "2026-05-14T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.reverted",
    payload: {
      threadId: THREAD_ID,
      turnCount: sequence,
    },
  };
}

it.effect("does not miss domain events committed while replay events are being read", () =>
  Effect.gen(function* () {
    const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
    const stream = yield* makeOrderedOrchestrationDomainEventStream({
      orchestrationEngine: {
        getReadModel: () => Effect.succeed({ snapshotSequence: 1 }),
        readEvents: () =>
          Stream.unwrap(PubSub.publish(liveEvents, makeEvent(2)).pipe(Effect.as(Stream.empty))),
        streamDomainEvents: Stream.fromPubSub(liveEvents),
      },
    });

    const events = yield* Stream.take(stream, 1).pipe(
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.timeoutOption("1 second"),
    );

    assertTrue(Option.isSome(events));
    assert.deepEqual(
      events.value.map((event) => event.sequence),
      [2],
    );
  }),
);

function makeThinkingDeltaEvent(
  delta: string,
  streamKind: "reasoning_text" | "reasoning_summary_text" = "reasoning_text",
): ProviderRuntimeEvent {
  return {
    eventId: EventId.makeUnsafe(`evt-thinking-${delta}`),
    provider: "copilot",
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: undefined,
    createdAt: "2026-05-14T00:00:00.000Z",
    type: "content.delta",
    payload: { streamKind, delta },
  } as ProviderRuntimeEvent;
}

function makeTextDeltaEvent(delta: string): ProviderRuntimeEvent {
  return {
    eventId: EventId.makeUnsafe(`evt-text-${delta}`),
    provider: "copilot",
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: undefined,
    createdAt: "2026-05-14T00:00:00.000Z",
    type: "content.delta",
    payload: { streamKind: "assistant_text", delta },
  } as ProviderRuntimeEvent;
}

it.effect(
  "makeThinkingActivityDeltaStream: emits nothing when enableThinkingStreaming is false",
  () =>
    Effect.gen(function* () {
      const stream = yield* makeThinkingActivityDeltaStream({
        providerService: {
          streamEvents: Stream.make(makeThinkingDeltaEvent("hello")),
        },
        serverSettings: {
          getSettings: Effect.succeed({ enableThinkingStreaming: false }),
        },
      });

      const events = yield* Stream.runCollect(stream).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.deepEqual(events, []);
    }),
);

it.effect("makeThinkingActivityDeltaStream: emits nothing when settings load fails", () =>
  Effect.gen(function* () {
    const stream = yield* makeThinkingActivityDeltaStream({
      providerService: {
        streamEvents: Stream.make(makeThinkingDeltaEvent("hello")),
      },
      serverSettings: {
        getSettings: Effect.fail(
          new ServerSettingsError({
            settingsPath: "/etc/settings.json",
            detail: "settings unavailable",
          }),
        ),
      },
    });

    const events = yield* Stream.runCollect(stream).pipe(Effect.map((chunk) => Array.from(chunk)));
    assert.deepEqual(events, []);
  }),
);

it.effect(
  "makeThinkingActivityDeltaStream: passes through thinking events and filters non-thinking",
  () =>
    Effect.gen(function* () {
      const stream = yield* makeThinkingActivityDeltaStream({
        providerService: {
          streamEvents: Stream.make(
            makeThinkingDeltaEvent("step 1"),
            makeTextDeltaEvent("answer"),
            makeThinkingDeltaEvent("step 2", "reasoning_summary_text"),
          ),
        },
        serverSettings: {
          getSettings: Effect.succeed({ enableThinkingStreaming: true }),
        },
      });

      const events = yield* Stream.runCollect(stream).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );

      assert.equal(events.length, 2);
      const [first, second] = events;
      assert.equal(first?.delta, "step 1");
      assert.equal(first?.streamKind, "reasoning_text");
      assert.equal(second?.delta, "step 2");
      assert.equal(second?.streamKind, "reasoning_summary_text");
    }),
);
