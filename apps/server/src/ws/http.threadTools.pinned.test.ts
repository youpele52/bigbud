import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { ProjectId, ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { afterEach, describe, expect, vi } from "vitest";

import { setThreadOrchestrationToolDispatcher } from "../orchestration-tools/ThreadOrchestrationToolDispatcher.ts";
import { writeThreadOrchestrationToolAuth } from "../orchestration-tools/ThreadOrchestrationToolAuth.ts";
import { buildAppUnderTest, getHttpServerUrl, serverTestLayer } from "../server.test.helpers.ts";
import { deriveServerPaths } from "../startup/config.ts";

const CALLER_THREAD_ID = "thread-pinned-caller";
const TARGET_THREAD_ID = "thread-pinned-other-project";
const TOKEN = "thread-pinned-token";

describe("thread orchestration pinned tools route", () => {
  afterEach(() => {
    setThreadOrchestrationToolDispatcher(null);
  });

  it.layer(serverTestLayer)("POST /api/internal/thread-tools", (it) => {
    it.effect("lists global pins and forwards a different target thread", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tempBaseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-tools-pinned-",
        });
        const { stateDir } = yield* deriveServerPaths(tempBaseDir, undefined);
        yield* Effect.promise(() =>
          writeThreadOrchestrationToolAuth({
            stateDir,
            threadId: CALLER_THREAD_ID,
            token: TOKEN,
          }),
        );

        const listPinned = vi.fn(() =>
          Effect.succeed({
            count: 1,
            limit: 5 as const,
            remaining: 4,
            threads: [
              {
                threadId: ThreadId.makeUnsafe(TARGET_THREAD_ID),
                title: "Other project thread",
                projectId: ProjectId.makeUnsafe("project-pinned-other"),
                projectTitle: null,
                archived: false,
                available: true,
              },
            ],
          }),
        );
        const setPinned = vi.fn(({ threadId, pinned }) =>
          Effect.succeed({
            threadId,
            pinned,
            pinnedAt: pinned ? new Date().toISOString() : null,
            count: 1,
            limit: 5 as const,
            remaining: 4,
          }),
        );
        setThreadOrchestrationToolDispatcher({
          rename: () => Effect.succeed({ title: "Renamed" }),
          archive: () => Effect.succeed({ archived: true as const }),
          getStatus: () => Effect.die("not used"),
          listPinned,
          setPinned,
          computerUse: () => Effect.die("not used"),
          browser: () => Effect.die("not used"),
        });

        yield* buildAppUnderTest({ config: { baseDir: tempBaseDir } });
        const url = yield* getHttpServerUrl("/api/internal/thread-tools");
        const headers = {
          "content-type": "application/json",
          "x-bigbud-thread-tool-token": TOKEN,
        };

        const listResponse = yield* Effect.promise(() =>
          fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ action: "list_pinned" }),
          }),
        );
        assert.equal(listResponse.status, 200);
        expect(listPinned).toHaveBeenCalledWith({
          callerThreadId: ThreadId.makeUnsafe(CALLER_THREAD_ID),
        });

        const pinResponse = yield* Effect.promise(() =>
          fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ action: "pin", threadId: TARGET_THREAD_ID }),
          }),
        );
        assert.equal(pinResponse.status, 200);
        expect(setPinned).toHaveBeenCalledWith({
          callerThreadId: ThreadId.makeUnsafe(CALLER_THREAD_ID),
          threadId: ThreadId.makeUnsafe(TARGET_THREAD_ID),
          pinned: true,
        });
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
    );
  });
});
