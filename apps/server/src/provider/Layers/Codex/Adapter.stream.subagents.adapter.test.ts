import assert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
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

const manager = new FakeCodexManager();
const layer = it.layer(
  makeCodexAdapterLive({ manager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("CodexAdapterLive collab subagents", (it) => {
  it.effect("emits a providerSubagent task beside the unchanged collab item lifecycle", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const fiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
        Effect.forkChild,
      );
      manager.emit("event", {
        id: asEventId("evt-collab-spawn"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-collab"),
        sessionEpoch: 1,
        createdAt: "2026-10-16T00:00:00.000Z",
        method: "item/started",
        turnId: asTurnId("turn-collab"),
        payload: {
          threadId: "provider-parent",
          turnId: "turn-collab",
          item: {
            type: "collabAgentToolCall",
            id: "call-spawn",
            tool: "spawnAgent",
            status: "inProgress",
            senderThreadId: "provider-parent",
            receiverThreadIds: ["child-1"],
            prompt: "Review the diff",
            model: "gpt-5-codex",
            reasoningEffort: "medium",
            agentsStates: { "child-1": { status: "running", message: null } },
          },
        },
      } satisfies ProviderEvent);
      const events = Array.from(yield* Fiber.join(fiber));
      assert.equal(events[0]?.type, "item.started");
      const task = events[1];
      assert.equal(task?.type, "task.updated");
      if (task?.type !== "task.updated") return;
      assert.equal(task.payload.kind, "providerSubagent");
      assert.equal(task.payload.nativeId, "child-1");
      assert.equal(task.payload.model, "gpt-5-codex");
      assert.equal(task.turnId, "turn-collab");
    }),
  );
});
