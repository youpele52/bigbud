import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { ProjectId, ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { afterEach, describe, expect, vi } from "vitest";

import { setThreadOrchestrationToolDispatcher } from "../orchestration-tools/ThreadOrchestrationToolDispatcher.ts";
import { writeThreadOrchestrationToolAuth } from "../orchestration-tools/ThreadOrchestrationToolAuth.ts";
import { buildAppUnderTest, getHttpServerUrl, serverTestLayer } from "../server.test.helpers.ts";
import { deriveServerPaths } from "../startup/config.ts";

const CALLER_THREAD_ID = "thread-list-caller";
const TOKEN = "thread-list-token";

const emptyListing = {
  projectId: ProjectId.makeUnsafe("project-list"),
  projectTitle: "Project list",
  status: "active" as const,
  limit: 50,
  totalCount: 0,
  returnedCount: 0,
  hasMore: false,
  threads: [],
};

const baseDispatcher = {
  rename: () => Effect.succeed({ title: "Renamed" }),
  archive: () => Effect.succeed({ archived: true as const }),
  getStatus: () => Effect.die("not used"),
  listPinned: () => Effect.succeed({ count: 0, limit: 5 as const, remaining: 5, threads: [] }),
  setPinned: () => Effect.die("not used"),
  computerUse: () => Effect.die("not used"),
  browser: () => Effect.die("not used"),
};

const setupAuth = Effect.fn("setupListThreadsAuth")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const tempBaseDir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "thread-tools-list-",
  });
  const { stateDir } = yield* deriveServerPaths(tempBaseDir, undefined);
  yield* Effect.promise(() =>
    writeThreadOrchestrationToolAuth({
      stateDir,
      threadId: CALLER_THREAD_ID,
      token: TOKEN,
    }),
  );
  return { tempBaseDir };
});

const REQUEST_HEADERS = {
  "content-type": "application/json",
  "x-bigbud-thread-tool-token": TOKEN,
};

describe("thread orchestration list_threads route", () => {
  afterEach(() => {
    setThreadOrchestrationToolDispatcher(null);
  });

  it.layer(serverTestLayer)("POST /api/internal/thread-tools", (it) => {
    it.effect("forwards filters to the dispatcher", () =>
      Effect.gen(function* () {
        const { tempBaseDir } = yield* setupAuth();
        const listThreads = vi.fn(() => Effect.succeed(emptyListing));
        setThreadOrchestrationToolDispatcher({ ...baseDispatcher, listThreads });

        yield* buildAppUnderTest({ config: { baseDir: tempBaseDir } });
        const url = yield* getHttpServerUrl("/api/internal/thread-tools");

        const response = yield* Effect.promise(() =>
          fetch(url, {
            method: "POST",
            headers: REQUEST_HEADERS,
            body: JSON.stringify({
              action: "list_threads",
              projectId: " project-other ",
              status: "all",
              limit: 10,
              includeExcerpt: true,
            }),
          }),
        );

        assert.equal(response.status, 200);
        expect(listThreads).toHaveBeenCalledWith({
          callerThreadId: ThreadId.makeUnsafe(CALLER_THREAD_ID),
          projectId: ProjectId.makeUnsafe("project-other"),
          status: "all",
          limit: 10,
          includeExcerpt: true,
        });
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
    );

    it.effect("omits absent filters so the caller project and defaults apply", () =>
      Effect.gen(function* () {
        const { tempBaseDir } = yield* setupAuth();
        const listThreads = vi.fn(() => Effect.succeed(emptyListing));
        setThreadOrchestrationToolDispatcher({ ...baseDispatcher, listThreads });

        yield* buildAppUnderTest({ config: { baseDir: tempBaseDir } });
        const url = yield* getHttpServerUrl("/api/internal/thread-tools");

        const response = yield* Effect.promise(() =>
          fetch(url, {
            method: "POST",
            headers: REQUEST_HEADERS,
            body: JSON.stringify({ action: "list_threads" }),
          }),
        );

        assert.equal(response.status, 200);
        expect(listThreads).toHaveBeenCalledWith({
          callerThreadId: ThreadId.makeUnsafe(CALLER_THREAD_ID),
          includeExcerpt: false,
        });
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
    );

    it.effect("rejects an unsupported status filter", () =>
      Effect.gen(function* () {
        const { tempBaseDir } = yield* setupAuth();
        const listThreads = vi.fn(() => Effect.succeed(emptyListing));
        setThreadOrchestrationToolDispatcher({ ...baseDispatcher, listThreads });

        yield* buildAppUnderTest({ config: { baseDir: tempBaseDir } });
        const url = yield* getHttpServerUrl("/api/internal/thread-tools");

        const response = yield* Effect.promise(() =>
          fetch(url, {
            method: "POST",
            headers: REQUEST_HEADERS,
            body: JSON.stringify({ action: "list_threads", status: "open" }),
          }),
        );

        assert.equal(response.status, 400);
        expect(listThreads).not.toHaveBeenCalled();
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
    );

    it.effect("reports unavailable when the dispatcher cannot list threads", () =>
      Effect.gen(function* () {
        const { tempBaseDir } = yield* setupAuth();
        setThreadOrchestrationToolDispatcher({ ...baseDispatcher });

        yield* buildAppUnderTest({ config: { baseDir: tempBaseDir } });
        const url = yield* getHttpServerUrl("/api/internal/thread-tools");

        const response = yield* Effect.promise(() =>
          fetch(url, {
            method: "POST",
            headers: REQUEST_HEADERS,
            body: JSON.stringify({ action: "list_threads" }),
          }),
        );

        assert.equal(response.status, 503);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
    );
  });
});
