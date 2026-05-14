import { EventId, ThreadId, TurnId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { type Event as OpencodeEvent } from "@opencode-ai/sdk/v2";
import { Effect } from "effect";

import { makeHandleEvent } from "./Adapter.stream.ts";
import type { ActiveOpencodeSession } from "./Adapter.types.ts";

const CREATED_AT = "2026-05-14T00:00:00.000Z";
const THREAD_ID = ThreadId.makeUnsafe("thread-opencode-stream-test");
const TURN_ID = TurnId.makeUnsafe("turn-opencode-stream-test");

function makeSession(
  runtimeMode: ActiveOpencodeSession["runtimeMode"] = "full-access",
): ActiveOpencodeSession {
  return {
    client: {} as never,
    releaseServer: () => undefined,
    opencodeSessionId: "opencode-session-1",
    threadId: THREAD_ID,
    createdAt: CREATED_AT,
    runtimeMode,
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

function makePermissionAskedEvent(session: ActiveOpencodeSession): OpencodeEvent {
  return {
    type: "permission.asked",
    properties: {
      id: "perm-1",
      sessionID: session.opencodeSessionId,
      permission: "bash",
      patterns: ["pwd"],
      always: [],
      metadata: {},
    },
  } as OpencodeEvent;
}

it.effect(
  "suppresses OpenCode permission popups in full-access and auto-approves immediately",
  () => {
    const session = makeSession("full-access");
    let emitted: ReadonlyArray<ProviderRuntimeEvent> = [];
    const scheduled: string[] = [];

    return Effect.gen(function* () {
      const handleEvent = makeHandleEvent(
        Effect.succeed(EventId.makeUnsafe("evt-next")),
        () =>
          Effect.succeed({
            eventId: EventId.makeUnsafe("evt-1"),
            createdAt: CREATED_AT,
          }),
        undefined,
        (events) =>
          Effect.sync(() => {
            emitted = events;
          }),
        (_session, requestId) => {
          scheduled.push(requestId);
        },
      );

      yield* handleEvent(session, makePermissionAskedEvent(session));

      assert.deepStrictEqual(emitted, []);
      assert.deepStrictEqual(scheduled, ["perm-1"]);
      assert.isTrue(session.pendingPermissions.has("perm-1"));
    });
  },
);

it.effect("still emits OpenCode permission requests outside full-access", () => {
  const session = makeSession("approval-required");
  let emitted: ReadonlyArray<ProviderRuntimeEvent> = [];
  const scheduled: string[] = [];

  return Effect.gen(function* () {
    const handleEvent = makeHandleEvent(
      Effect.succeed(EventId.makeUnsafe("evt-next")),
      () =>
        Effect.succeed({
          eventId: EventId.makeUnsafe("evt-1"),
          createdAt: CREATED_AT,
        }),
      undefined,
      (events) =>
        Effect.sync(() => {
          emitted = events;
        }),
      (_session, requestId) => {
        scheduled.push(requestId);
      },
    );

    yield* handleEvent(session, makePermissionAskedEvent(session));

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.type, "request.opened");
    assert.deepStrictEqual(scheduled, []);
  });
});
