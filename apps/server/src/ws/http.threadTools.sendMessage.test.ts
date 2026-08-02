import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { afterEach, describe, expect, vi } from "vitest";

import { writeThreadOrchestrationToolAuth } from "../orchestration-tools/ThreadOrchestrationToolAuth.ts";
import { setThreadOrchestrationToolDispatcher } from "../orchestration-tools/ThreadOrchestrationToolDispatcher.ts";
import { buildAppUnderTest, getHttpServerUrl, serverTestLayer } from "../server.test.helpers.ts";
import { deriveServerPaths } from "../startup/config.ts";

const callerThreadId = ThreadId.makeUnsafe("thread-http-send-caller");
const token = "thread-http-send-token";

describe("thread orchestration send route", () => {
  afterEach(() => setThreadOrchestrationToolDispatcher(null));

  it.layer(serverTestLayer)("POST /api/internal/thread-tools", (it) => {
    it.effect("authenticates and scopes send_thread_message to the caller thread", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tempBaseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-tools-send-",
        });
        const { stateDir } = yield* deriveServerPaths(tempBaseDir, undefined);
        yield* Effect.promise(() =>
          writeThreadOrchestrationToolAuth({ stateDir, threadId: callerThreadId, token }),
        );
        const sendMessage = vi.fn((input: { callerThreadId: ThreadId; threadId: ThreadId }) => {
          if (input.threadId === "thread-cross-project") {
            return Effect.fail(new Error("not accessible from the current project"));
          }
          if (input.threadId === "thread-missing") {
            return Effect.fail(new Error("Thread 'thread-missing' was not found."));
          }
          return Effect.succeed({ delivery: "queued" as const, queuePosition: 1 });
        });
        setThreadOrchestrationToolDispatcher({
          rename: () => Effect.succeed({ title: "Renamed" }),
          archive: () => Effect.succeed({ archived: true as const }),
          getStatus: () => Effect.die("unused"),
          listPinned: () => Effect.succeed({ count: 0, limit: 5, remaining: 5, threads: [] }),
          setPinned: () => Effect.die("unused"),
          computerUse: () => Effect.die("unused"),
          browser: () => Effect.die("unused"),
          sendMessage,
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

        const success = yield* request({
          action: "send_thread_message",
          threadId: "thread-same-project",
          message: "Follow up",
          invocationId: "send-call-1",
        });
        assert.equal(success.status, 200);
        expect(sendMessage).toHaveBeenCalledWith({
          callerThreadId,
          threadId: ThreadId.makeUnsafe("thread-same-project"),
          message: "Follow up",
          delivery: "auto",
          invocationId: "send-call-1",
        });

        assert.equal(
          (yield* request({
            action: "send_thread_message",
            threadId: "thread-cross-project",
            message: "Denied",
            invocationId: "send-call-2",
          })).status,
          400,
        );
        assert.equal(
          (yield* request({
            action: "send_thread_message",
            threadId: "thread-missing",
            message: "Missing",
            invocationId: "send-call-3",
          })).status,
          404,
        );
        assert.equal(
          (yield* request({
            action: "send_thread_message",
            threadId: 42,
            invocationId: "send-call-4",
          })).status,
          400,
        );
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
    );
  });
});
