import { ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { afterEach, describe, expect, vi } from "vitest";

import { writeThreadOrchestrationToolAuth } from "../orchestration-tools/ThreadOrchestrationToolAuth.ts";
import { setThreadOrchestrationToolDispatcher } from "../orchestration-tools/ThreadOrchestrationToolDispatcher.ts";
import { buildAppUnderTest, getHttpServerUrl, serverTestLayer } from "../server.test.helpers.ts";
import { serverHttpTestLayer } from "../server.test.http.ts";
import { deriveServerPaths } from "../startup/config.ts";

const callerThreadId = ThreadId.makeUnsafe("thread-http-model-choice-caller");
const token = "thread-http-model-choice-token";

describe("thread orchestration model choice routes", () => {
  afterEach(() => setThreadOrchestrationToolDispatcher(null));

  it.layer(serverTestLayer)("POST /api/internal/thread-tools", (it) => {
    it.effect("passes a raw modelSelection to create_thread and serves list_available_models", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tempBaseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-tools-model-choice-",
        });
        const { stateDir } = yield* deriveServerPaths(tempBaseDir, undefined);
        yield* Effect.promise(() =>
          writeThreadOrchestrationToolAuth({ stateDir, threadId: callerThreadId, token }),
        );
        const createThread = vi.fn((_input: Record<string, unknown>) =>
          Effect.succeed({ accepted: true, modelChoice: { status: "pending" } } as never),
        );
        const listAvailableModels = vi.fn((_input: Record<string, unknown>) =>
          Effect.succeed({ models: [], hasMore: false } as never),
        );
        setThreadOrchestrationToolDispatcher({
          rename: () => Effect.succeed({ title: "Renamed" }),
          archive: () => Effect.succeed({ archived: true as const }),
          getStatus: () => Effect.die("unused"),
          listPinned: () => Effect.succeed({ count: 0, limit: 5, remaining: 5, threads: [] }),
          setPinned: () => Effect.die("unused"),
          computerUse: () => Effect.die("unused"),
          browser: () => Effect.die("unused"),
          createThread,
          listAvailableModels,
        });
        yield* buildAppUnderTest({ config: { baseDir: tempBaseDir } });
        const url = yield* getHttpServerUrl("/api/internal/thread-tools");
        const request = (body: unknown) =>
          Effect.promise(() =>
            fetch(url, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-bigbud-thread-tool-token": token,
              },
              body: JSON.stringify(body),
            }),
          );

        const created = yield* request({
          action: "create_thread",
          title: "Child",
          task: "Work",
          invocationId: "create-1",
          sourceMessageId: "message-1",
          modelSelection: { provider: "not-a-provider", model: 42 },
        });
        assert.equal(created.status, 200);
        expect(createThread.mock.calls[0]?.[0]).toMatchObject({
          callerThreadId,
          modelSelection: { provider: "not-a-provider", model: 42 },
        });
        yield* request({
          action: "create_thread",
          title: "Child",
          task: "Work",
          invocationId: "create-2",
          sourceMessageId: "message-1",
        });
        expect(createThread.mock.calls[1]?.[0]).not.toHaveProperty("modelSelection");

        const listed = yield* request({ action: "list_available_models", limit: 7 });
        assert.equal(listed.status, 200);
        assert.deepStrictEqual(yield* Effect.promise(() => listed.json()), {
          ok: true,
          result: { models: [], hasMore: false },
        });
        expect(listAvailableModels).toHaveBeenCalledWith({ callerThreadId, limit: 7 });
      }).pipe(Effect.provide(serverHttpTestLayer)),
    );
  });
});
