import assert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, it } from "@effect/vitest";

import { Effect, Fiber, Layer, Stream } from "effect";

import type { ProviderEvent } from "@bigbud/contracts";

import { ServerConfig } from "../../../startup/config.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { CodexAdapter } from "../../Services/Codex/Adapter.ts";
import { makeCodexAdapterLive } from "./Adapter.ts";
import {
  FakeCodexManager,
  asEventId,
  asItemId,
  asThreadId,
  asTurnId,
  providerSessionDirectoryTestLayer,
} from "./Adapter.test.helpers.ts";

const lifecycleManager = new FakeCodexManager();
const lifecycleLayer = it.layer(
  makeCodexAdapterLive({ manager: lifecycleManager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

lifecycleLayer("CodexAdapterLive lifecycle", (it) => {
  it.effect("maps completed agent message items to canonical item.completed events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-msg-complete"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("msg_1"),
        payload: {
          item: {
            type: "agentMessage",
            id: "msg_1",
          },
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "item.completed");
      if (firstEvent.value.type !== "item.completed") {
        return;
      }
      assert.equal(firstEvent.value.itemId, "msg_1");
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.itemType, "assistant_message");
    }),
  );

  it.effect("maps completed plan items to canonical proposed-plan completion events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-plan-complete"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("plan_1"),
        payload: {
          item: {
            type: "Plan",
            id: "plan_1",
            text: "## Final plan\n\n- one\n- two",
          },
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "turn.proposed.completed");
      if (firstEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.planMarkdown, "## Final plan\n\n- one\n- two");
    }),
  );

  it.effect("maps plan deltas to canonical proposed-plan delta events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-plan-delta"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/plan/delta",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("plan_1"),
        payload: {
          delta: "## Final plan",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "turn.proposed.delta");
      if (firstEvent.value.type !== "turn.proposed.delta") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.delta, "## Final plan");
    }),
  );

  it.effect("maps session/closed lifecycle events to canonical session.exited runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-session-closed"),
        kind: "session",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "session/closed",
        message: "Session stopped",
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "session.exited");
      if (firstEvent.value.type !== "session.exited") {
        return;
      }
      assert.equal(firstEvent.value.threadId, "thread-1");
      assert.equal(firstEvent.value.payload.reason, "Session stopped");
    }),
  );

  it.effect("maps windowsSandbox/setupCompleted to session state and warning on failure", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
        Effect.forkChild,
      );

      const event: ProviderEvent = {
        id: asEventId("evt-windows-sandbox-failed"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "windowsSandbox/setupCompleted",
        message: "Sandbox setup failed",
        payload: {
          success: false,
          detail: "unsupported environment",
        },
      };

      lifecycleManager.emit("event", event);
      const events = Array.from(yield* Fiber.join(eventsFiber));

      assert.equal(events.length, 2);

      const firstEvent = events[0];
      const secondEvent = events[1];

      assert.equal(firstEvent?.type, "session.state.changed");
      if (firstEvent?.type === "session.state.changed") {
        assert.equal(firstEvent.payload.state, "error");
        assert.equal(firstEvent.payload.reason, "Sandbox setup failed");
      }

      assert.equal(secondEvent?.type, "runtime.warning");
      if (secondEvent?.type === "runtime.warning") {
        assert.equal(secondEvent.payload.message, "Sandbox setup failed");
      }
    }),
  );
});

afterAll(() => {
  if (lifecycleManager.stopAllImpl.mock.calls.length === 0) {
    lifecycleManager.stopAll();
  }
  assert.ok(lifecycleManager.stopAllImpl.mock.calls.length >= 1);
});
