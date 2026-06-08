import assert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, it } from "@effect/vitest";

import { Effect, Fiber, Layer, Stream } from "effect";

import { ApprovalRequestId, type ProviderEvent } from "@bigbud/contracts";

import { ServerConfig } from "../../../startup/config.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { CodexAdapter } from "../../Services/Codex/Adapter.ts";
import { makeCodexAdapterLive } from "./Adapter.ts";
import {
  FakeCodexManager,
  asEventId,
  asThreadId,
  providerSessionDirectoryTestLayer,
} from "./Adapter.test.helpers.ts";

const requestManager = new FakeCodexManager();
const requestLayer = it.layer(
  makeCodexAdapterLive({ manager: requestManager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

requestLayer("CodexAdapterLive request events", (it) => {
  it.effect("preserves request type when mapping serverRequest/resolved", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-request-resolved"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "serverRequest/resolved",
        requestId: ApprovalRequestId.makeUnsafe("req-1"),
        payload: {
          request: {
            method: "item/commandExecution/requestApproval",
          },
          decision: "accept",
        },
      };

      requestManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "request.resolved");
      if (firstEvent.value.type !== "request.resolved") {
        return;
      }
      assert.equal(firstEvent.value.payload.requestType, "command_execution_approval");
    }),
  );

  it.effect("preserves file-read request type when mapping serverRequest/resolved", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-file-read-request-resolved"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "serverRequest/resolved",
        requestId: ApprovalRequestId.makeUnsafe("req-file-read-1"),
        payload: {
          request: {
            method: "item/fileRead/requestApproval",
          },
          decision: "accept",
        },
      };

      requestManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "request.resolved");
      if (firstEvent.value.type !== "request.resolved") {
        return;
      }
      assert.equal(firstEvent.value.payload.requestType, "file_read_approval");
    }),
  );

  it.effect("preserves explicit empty multi-select user-input answers", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-user-input-empty"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "item/tool/requestUserInput/answered",
        payload: {
          answers: {
            scope: [],
          },
        },
      };

      requestManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "user-input.resolved");
      if (firstEvent.value.type !== "user-input.resolved") {
        return;
      }
      assert.deepEqual(firstEvent.value.payload.answers, {
        scope: [],
      });
    }),
  );

  it.effect(
    "maps requestUserInput requests and answered notifications to canonical user-input events",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
          Effect.forkChild,
        );

        requestManager.emit("event", {
          id: asEventId("evt-user-input-requested"),
          kind: "request",
          provider: "codex",
          threadId: asThreadId("thread-1"),
          createdAt: new Date().toISOString(),
          method: "item/tool/requestUserInput",
          requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
          payload: {
            questions: [
              {
                id: "sandbox_mode",
                header: "Sandbox",
                question: "Which mode should be used?",
                options: [
                  {
                    label: "workspace-write",
                    description: "Allow workspace writes only",
                  },
                ],
                multiSelect: true,
              },
            ],
          },
        } satisfies ProviderEvent);
        requestManager.emit("event", {
          id: asEventId("evt-user-input-resolved"),
          kind: "notification",
          provider: "codex",
          threadId: asThreadId("thread-1"),
          createdAt: new Date().toISOString(),
          method: "item/tool/requestUserInput/answered",
          requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
          payload: {
            answers: {
              sandbox_mode: {
                answers: ["workspace-write"],
              },
            },
          },
        } satisfies ProviderEvent);

        const events = Array.from(yield* Fiber.join(eventsFiber));
        assert.equal(events[0]?.type, "user-input.requested");
        if (events[0]?.type === "user-input.requested") {
          assert.equal(events[0].requestId, "req-user-input-1");
          assert.equal(events[0].payload.questions[0]?.id, "sandbox_mode");
          assert.equal(events[0].payload.questions[0]?.multiSelect, true);
        }

        assert.equal(events[1]?.type, "user-input.resolved");
        if (events[1]?.type === "user-input.resolved") {
          assert.equal(events[1].requestId, "req-user-input-1");
          assert.deepEqual(events[1].payload.answers, {
            sandbox_mode: "workspace-write",
          });
        }
      }),
  );
});

afterAll(() => {
  if (requestManager.stopAllImpl.mock.calls.length === 0) {
    requestManager.stopAll();
  }
  assert.ok(requestManager.stopAllImpl.mock.calls.length >= 1);
});
