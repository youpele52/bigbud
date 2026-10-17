import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { afterEach, describe, vi } from "vitest";

import { setThreadOrchestrationToolDispatcher } from "../orchestration-tools/ThreadOrchestrationToolDispatcher.ts";
import { writeThreadOrchestrationToolAuth } from "../orchestration-tools/ThreadOrchestrationToolAuth.ts";
import { buildAppUnderTest, getHttpServerUrl, serverTestLayer } from "../server.test.helpers.ts";
import { deriveServerPaths } from "../startup/config.ts";

const TOKEN = "thread-system-resources-token";
const snapshot = { available: false, reason: "desktop monitor unavailable" };
const dispatcher = {
  rename: () => Effect.succeed({ title: "Renamed" }),
  archive: () => Effect.succeed({ archived: true as const }),
  getStatus: () => Effect.die("not used"),
  listPinned: () => Effect.succeed({ count: 0, limit: 5 as const, remaining: 5, threads: [] }),
  setPinned: () => Effect.die("not used"),
  computerUse: () => Effect.die("not used"),
  browser: () => Effect.die("not used"),
};

describe("thread system resources route", () => {
  afterEach(() => setThreadOrchestrationToolDispatcher(null));
  it.layer(serverTestLayer)("POST /api/internal/thread-tools", (it) => {
    it.effect("allows an authenticated thread to request the desktop snapshot", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempBaseDir = yield* fs.makeTempDirectoryScoped({ prefix: "thread-resources-" });
        const { stateDir } = yield* deriveServerPaths(tempBaseDir, undefined);
        yield* Effect.promise(() =>
          writeThreadOrchestrationToolAuth({ stateDir, threadId: "resource-thread", token: TOKEN }),
        );
        const getSystemResources = vi.fn(() => Effect.succeed(snapshot));
        setThreadOrchestrationToolDispatcher({ ...dispatcher, getSystemResources });
        yield* buildAppUnderTest({ config: { baseDir: tempBaseDir } });
        const url = yield* getHttpServerUrl("/api/internal/thread-tools");
        const denied = yield* Effect.promise(() =>
          fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "get_system_resources" }),
          }),
        );
        assert.equal(denied.status, 401);
        assert.equal(getSystemResources.mock.calls.length, 0);
        const response = yield* Effect.promise(() =>
          fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bigbud-thread-tool-token": TOKEN },
            body: JSON.stringify({ action: "get_system_resources" }),
          }),
        );
        assert.equal(response.status, 200);
        assert.equal(getSystemResources.mock.calls.length, 1);
        const body = (yield* Effect.promise(() => response.json())) as { result: unknown };
        assert.deepEqual(body.result, snapshot);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
    );
  });
});
