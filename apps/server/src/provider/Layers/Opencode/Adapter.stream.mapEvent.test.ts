import { EventId, ThreadId, TurnId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { type Event as OpencodeEvent } from "@opencode-ai/sdk/v2";
import { Effect } from "effect";

import { makeMapEvent } from "./Adapter.stream.mapEvent.ts";
import type { ActiveOpencodeSession } from "./Adapter.types.ts";

const CREATED_AT = "2026-05-04T00:00:00.000Z";
const THREAD_ID = ThreadId.makeUnsafe("thread-opencode-stream-map-event-test");
const TURN_ID = TurnId.makeUnsafe("turn-opencode-stream-map-event-test");

function makeSession(): ActiveOpencodeSession {
  return {
    client: {} as never,
    releaseServer: () => undefined,
    opencodeSessionId: "opencode-session-1",
    threadId: THREAD_ID,
    createdAt: CREATED_AT,
    runtimeMode: "full-access",
    pendingPermissions: new Map(),
    pendingUserInputs: new Map(),
    turns: [],
    sseAbortController: null,
    cwd: "/tmp/opencode-project",
    model: undefined,
    providerID: undefined,
    updatedAt: CREATED_AT,
    lastError: undefined,
    activeTurnId: TURN_ID,
    lastUsage: undefined,
    wasRetrying: false,
    reasoningPartIds: new Set(),
  };
}

function makeMapEventUnderTest() {
  let stampIndex = 0;

  return makeMapEvent(Effect.succeed(EventId.makeUnsafe("evt-next")), () =>
    Effect.succeed({
      eventId: EventId.makeUnsafe(`evt-${++stampIndex}`),
      createdAt: CREATED_AT,
    }),
  );
}

it.effect("infers context compaction from busy status messages as a fallback", () => {
  const session = makeSession();
  const mapEvent = makeMapEventUnderTest();

  return Effect.gen(function* () {
    const events = yield* mapEvent(session, {
      type: "session.status",
      properties: {
        sessionID: session.opencodeSessionId,
        status: {
          type: "busy",
          message: "Compacting conversation history",
        },
      },
    } as OpencodeEvent);

    assert.deepEqual(events, [
      {
        eventId: EventId.makeUnsafe("evt-next"),
        provider: "opencode",
        threadId: THREAD_ID,
        createdAt: CREATED_AT,
        turnId: TURN_ID,
        providerRefs: {
          providerTurnId: TURN_ID,
        },
        raw: {
          source: "opencode.sdk.session-event",
          method: "session.status",
          payload: {
            type: "session.status",
            properties: {
              sessionID: session.opencodeSessionId,
              status: {
                type: "busy",
                message: "Compacting conversation history",
              },
            },
          },
        },
        type: "session.state.changed",
        payload: {
          state: "waiting",
          reason: "context.compacting",
          detail: {
            type: "busy",
            message: "Compacting conversation history",
          },
        },
      },
    ]);
  });
});

it.effect("maps native session.compacted events to thread compacted state", () => {
  const session = makeSession();
  const mapEvent = makeMapEventUnderTest();

  return Effect.gen(function* () {
    const events = yield* mapEvent(session, {
      type: "session.compacted",
      properties: {
        sessionID: session.opencodeSessionId,
      },
    } as OpencodeEvent);

    assert.deepEqual(events, [
      {
        eventId: EventId.makeUnsafe("evt-1"),
        provider: "opencode",
        threadId: THREAD_ID,
        createdAt: CREATED_AT,
        turnId: TURN_ID,
        providerRefs: {
          providerTurnId: TURN_ID,
        },
        raw: {
          source: "opencode.sdk.session-event",
          method: "session.compacted",
          payload: {
            type: "session.compacted",
            properties: {
              sessionID: session.opencodeSessionId,
            },
          },
        },
        type: "thread.state.changed",
        payload: {
          state: "compacted",
          detail: {
            sessionID: session.opencodeSessionId,
          },
        },
      },
    ]);
  });
});

it.effect("maps message.part.updated(reasoning) + message.part.delta to reasoning_text", () => {
  const session = makeSession();
  const mapEvent = makeMapEventUnderTest();
  const PART_ID = "reasoning-part-1";

  return Effect.gen(function* () {
    // First, register the part as reasoning via message.part.updated
    const updatedEvents = yield* mapEvent(session, {
      type: "message.part.updated",
      properties: {
        sessionID: session.opencodeSessionId,
        part: { id: PART_ID, type: "reasoning", text: "", time: { start: 0 } },
        time: 0,
      },
    } as OpencodeEvent);

    // message.part.updated for reasoning emits no events
    assert.deepEqual(updatedEvents, []);
    assert.isTrue(session.reasoningPartIds.has(PART_ID));

    // Then a delta arrives with field: "text" — must map to reasoning_text
    const deltaEvents = yield* mapEvent(session, {
      type: "message.part.delta",
      properties: {
        sessionID: session.opencodeSessionId,
        messageID: "msg-1",
        partID: PART_ID,
        field: "text",
        delta: "thinking...",
      },
    } as OpencodeEvent);

    assert.equal(deltaEvents.length, 1);
    const ev = deltaEvents[0];
    assert.equal(ev?.type, "content.delta");
    const payload = (ev as { payload: { streamKind: string; delta: string } }).payload;
    assert.deepEqual(payload, {
      streamKind: "reasoning_text",
      delta: "thinking...",
    });
  });
});

it.effect(
  "maps message.part.delta with field:text and no registered part to assistant_text",
  () => {
    const session = makeSession();
    const mapEvent = makeMapEventUnderTest();

    return Effect.gen(function* () {
      const deltaEvents = yield* mapEvent(session, {
        type: "message.part.delta",
        properties: {
          sessionID: session.opencodeSessionId,
          messageID: "msg-2",
          partID: "text-part-1",
          field: "text",
          delta: "Hello world",
        },
      } as OpencodeEvent);

      assert.equal(deltaEvents.length, 1);
      const ev = deltaEvents[0];
      assert.equal(ev?.type, "content.delta");
      const payload = (ev as { payload: { streamKind: string; delta: string } }).payload;
      assert.deepEqual(payload, {
        streamKind: "assistant_text",
        delta: "Hello world",
      });
    });
  },
);
