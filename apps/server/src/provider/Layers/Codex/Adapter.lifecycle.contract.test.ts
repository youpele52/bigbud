import assert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ServerConfig } from "../../../startup/config.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { CodexAdapter } from "../../Services/Codex/Adapter.ts";
import { makeCodexAdapterLive } from "./Adapter.ts";
import {
  FakeCodexManager,
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

layer("Codex lifecycle contract", (it) => {
  it.effect("reports active and terminal sessions from the native manager", () =>
    Effect.gen(function* () {
      const threadId = asThreadId("codex-contract-thread");
      manager.setSession({
        threadId,
        provider: "codex",
        status: "running",
        runtimeMode: "full-access",
        activeTurnId: asTurnId("codex-contract-turn"),
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      const adapter = yield* CodexAdapter;
      assert.equal(
        (yield* adapter.listSessions())[0]?.activeTurnId,
        asTurnId("codex-contract-turn"),
      );
      manager.removeSession(threadId);
      assert.deepEqual(yield* adapter.listSessions(), []);
    }),
  );
});
