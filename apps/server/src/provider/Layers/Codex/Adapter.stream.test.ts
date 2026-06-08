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
  asThreadId,
  asTurnId,
  providerSessionDirectoryTestLayer,
} from "./Adapter.test.helpers.ts";

const streamManager = new FakeCodexManager();
const streamLayer = it.layer(
  makeCodexAdapterLive({ manager: streamManager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

streamLayer("CodexAdapterLive stream events", (it) => {
  it.effect("maps retryable Codex error notifications to runtime.warning", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      streamManager.emit("event", {
        id: asEventId("evt-retryable-error"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "error",
        turnId: asTurnId("turn-1"),
        payload: {
          error: {
            message: "Reconnecting... 2/5",
          },
          willRetry: true,
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.message, "Reconnecting... 2/5");
    }),
  );

  it.effect("maps process stderr notifications to runtime.warning", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      streamManager.emit("event", {
        id: asEventId("evt-process-stderr"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "process/stderr",
        turnId: asTurnId("turn-1"),
        message: "The filename or extension is too long. (os error 206)",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(
        firstEvent.value.payload.message,
        "The filename or extension is too long. (os error 206)",
      );
    }),
  );

  it.effect("maps fatal websocket stderr notifications to runtime.error", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      streamManager.emit("event", {
        id: asEventId("evt-process-stderr-websocket"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "process/stderr",
        turnId: asTurnId("turn-1"),
        message:
          "2026-03-31T18:14:06.833399Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 503 Service Unavailable, url: wss://chatgpt.com/backend-api/codex/responses",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.error");
      if (firstEvent.value.type !== "runtime.error") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.class, "provider_error");
      assert.equal(
        firstEvent.value.payload.message,
        "2026-03-31T18:14:06.833399Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 503 Service Unavailable, url: wss://chatgpt.com/backend-api/codex/responses",
      );
    }),
  );
});

afterAll(() => {
  if (streamManager.stopAllImpl.mock.calls.length === 0) {
    streamManager.stopAll();
  }
  assert.ok(streamManager.stopAllImpl.mock.calls.length >= 1);
});
