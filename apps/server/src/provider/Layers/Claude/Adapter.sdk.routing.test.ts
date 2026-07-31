import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Random, Stream } from "effect";

import { ClaudeAdapter } from "../../Services/Claude/Adapter.ts";
import { makeDeterministicRandomService, makeHarness, THREAD_ID } from "./Adapter.test.helpers.ts";
import {
  sdkApiRetryFixture,
  sdkCommandsChangedFixture,
  sdkElicitationCompleteFixture,
  sdkHookProgressFixture,
  sdkHookResponseFixture,
  sdkHookStartedFixture,
  sdkModelRefusalFallbackFixture,
  sdkModelRefusalNoFallbackFixture,
  sdkTaskNotificationFixture,
  sdkTaskProgressFixture,
  sdkTaskStartedFixture,
} from "./Adapter.sdk.fixtures.ts";

describe("Claude SDK normalized message routing", () => {
  it.effect("projects every supported fixture family without raw SDK payloads", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const eventsFiber = yield* Stream.take(adapter.streamEvents, 16).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });

      harness.query.emit(sdkTaskStartedFixture());
      harness.query.emit(sdkTaskProgressFixture());
      harness.query.emit(sdkTaskNotificationFixture());
      harness.query.emit(sdkHookStartedFixture());
      harness.query.emit(sdkHookProgressFixture());
      harness.query.emit(sdkHookResponseFixture());
      harness.query.emit(sdkApiRetryFixture());
      harness.query.emit(sdkModelRefusalFallbackFixture());
      harness.query.emit(sdkModelRefusalNoFallbackFixture());
      harness.query.emit(sdkCommandsChangedFixture());
      harness.query.emit(sdkElicitationCompleteFixture());
      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.deepEqual(
        events.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "thread.started",
          "task.started",
          "thread.token-usage.updated",
          "task.progress",
          "task.completed",
          "hook.started",
          "hook.progress",
          "hook.completed",
          "runtime.warning",
          "model.rerouted",
          "runtime.warning",
          "runtime.warning",
          "mcp.oauth.completed",
        ],
      );
      for (const event of events) {
        if (event.raw?.source !== "claude.sdk.message") continue;
        assert.deepEqual(Object.keys(event.raw.payload as object).toSorted(), [
          "message",
          "sdkVersion",
        ]);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("reports invalid known families with bounded payload-free diagnostics", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const eventsFiber = yield* Stream.take(adapter.streamEvents, 5).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });
      harness.query.emitUnchecked({
        type: "system",
        subtype: "task_updated",
        task_id: "task-fixture",
        patch: { status: "invalid" },
        uuid: "00000000-0000-4000-8000-000000000001",
        session_id: "sdk-session-fixture",
        secret: "must-not-project",
      });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const warning = events.at(-1);
      assert.equal(warning?.type, "runtime.warning");
      if (warning?.type === "runtime.warning") {
        assert.deepEqual(warning.payload.detail, {
          sdkVersion: "0.3.219",
          message: "system/task_updated",
        });
        assert.equal(JSON.stringify(warning).includes("must-not-project"), false);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});
