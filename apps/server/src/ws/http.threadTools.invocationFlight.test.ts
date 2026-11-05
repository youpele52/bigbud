import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { afterEach, describe, vi } from "vitest";

import { setThreadOrchestrationToolDispatcher } from "../orchestration-tools/ThreadOrchestrationToolDispatcher.ts";
import { writeThreadOrchestrationToolAuth } from "../orchestration-tools/ThreadOrchestrationToolAuth.ts";
import {
  beginThreadToolDispatch,
  isThreadToolInvocationInFlight,
} from "../orchestration-tools/threadToolInvocationFlights.ts";
import { buildAppUnderTest, getHttpServerUrl, serverTestLayer } from "../server.test.helpers.ts";
import { serverHttpTestLayer } from "../server.test.http.ts";
import { deriveServerPaths } from "../startup/config.ts";

const TOKEN = "thread-invocation-flight-token";
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

const setup = Effect.fn("setupInvocationFlightRoute")(function* (
  getSystemResources: () => Effect.Effect<typeof snapshot>,
) {
  const fs = yield* FileSystem.FileSystem;
  const tempBaseDir = yield* fs.makeTempDirectoryScoped({ prefix: "thread-flight-" });
  const { stateDir } = yield* deriveServerPaths(tempBaseDir, undefined);
  yield* Effect.promise(() =>
    writeThreadOrchestrationToolAuth({ stateDir, threadId: "flight-thread", token: TOKEN }),
  );
  setThreadOrchestrationToolDispatcher({ ...dispatcher, getSystemResources });
  yield* buildAppUnderTest({ config: { baseDir: tempBaseDir } });
  const url = yield* getHttpServerUrl("/api/internal/thread-tools");
  return (invocationId: string) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bigbud-thread-tool-token": TOKEN },
      body: JSON.stringify({ action: "get_system_resources", invocationId }),
    });
});

describe("thread tool invocation flights on the route", () => {
  afterEach(() => setThreadOrchestrationToolDispatcher(null));
  it.layer(serverTestLayer)("POST /api/internal/thread-tools", (it) => {
    it.effect("refuses an invocation its in-process caller abandoned before arrival", () =>
      Effect.gen(function* () {
        const getSystemResources = vi.fn(() => Effect.succeed(snapshot));
        const post = yield* setup(getSystemResources);
        beginThreadToolDispatch("v2-tool:abandoned")();
        const refused = yield* Effect.promise(() => post("v2-tool:abandoned"));
        assert.equal(refused.status, 409);
        assert.equal(getSystemResources.mock.calls.length, 0);
      }).pipe(Effect.provide(serverHttpTestLayer)),
    );

    it.effect("keeps the invocation in flight until the handler has ended", () =>
      Effect.gen(function* () {
        let finish!: () => void;
        const gate = new Promise<void>((resolve) => (finish = resolve));
        const getSystemResources = vi.fn(() =>
          Effect.promise(() => gate).pipe(Effect.as(snapshot)),
        );
        const post = yield* setup(getSystemResources);
        const settle = beginThreadToolDispatch("v2-tool:running");
        const response = post("v2-tool:running");
        yield* Effect.promise(() =>
          vi.waitFor(() => assert.equal(getSystemResources.mock.calls.length, 1)),
        );
        settle(); // The caller's own bookkeeping ending never ends the handler's flight.
        assert.isTrue(isThreadToolInvocationInFlight("v2-tool:running"));
        finish();
        assert.equal((yield* Effect.promise(() => response)).status, 200);
        yield* Effect.promise(() =>
          vi.waitFor(() => assert.isFalse(isThreadToolInvocationInFlight("v2-tool:running"))),
        );
      }).pipe(Effect.provide(serverHttpTestLayer)),
    );
  });
});
