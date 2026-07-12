import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { afterEach, describe, expect, vi } from "vitest";

import { deriveServerPaths } from "../startup/config.ts";
import { buildAppUnderTest, getHttpServerUrl, serverTestLayer } from "../server.test.helpers.ts";
import {
  getThreadOrchestrationToolDispatcher,
  setThreadOrchestrationToolDispatcher,
} from "../orchestration-tools/ThreadOrchestrationToolDispatcher.ts";
import { writeThreadOrchestrationToolAuth } from "../orchestration-tools/ThreadOrchestrationToolAuth.ts";
import type { ThreadWorkflowStatusSnapshot } from "../orchestration/ThreadWorkflowStatus.logic.ts";

const THREAD_ID = "thread-http-computer-use";
const THREAD_TOOL_TOKEN = "thread-tool-token-http-computer-use";

describe("thread orchestration tools route", () => {
  afterEach(() => {
    setThreadOrchestrationToolDispatcher(null);
  });

  it.layer(serverTestLayer)("POST /api/internal/thread-tools", (it) => {
    it.effect("forwards computer_use actions to the orchestration dispatcher", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tempBaseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-tools-computer-use-",
        });
        const { stateDir } = yield* deriveServerPaths(tempBaseDir, undefined);

        yield* Effect.promise(() =>
          writeThreadOrchestrationToolAuth({
            stateDir,
            threadId: THREAD_ID,
            token: THREAD_TOOL_TOKEN,
          }),
        );

        const computerUse = vi.fn(({ action }: { action: { action: string } }) =>
          Effect.succeed({
            surface: "browser" as const,
            action: action.action,
            summary: "Captured the current page.",
            page: { url: "https://example.com", title: "Example" },
          }),
        );

        setThreadOrchestrationToolDispatcher({
          rename: () => Effect.succeed({ title: "Renamed" }),
          archive: () => Effect.succeed({ archived: true as const }),
          getStatus: () =>
            Effect.succeed({
              threadId: ThreadId.makeUnsafe(THREAD_ID),
              title: "Thread",
              workflowStatus: "idle",
              isAgentActive: false,
              isWorkflowComplete: false,
              sessionStatus: null,
              latestTurnState: null,
              latestTurnCompletedAt: null,
              hasPendingApprovals: false,
              hasPendingUserInput: false,
              hasActionableProposedPlan: false,
              lastAssistantExcerpt: null,
              updatedAt: new Date().toISOString(),
            }),
          computerUse,
          browser: () => Effect.succeed({ action: "capture", summary: "Captured browser." }),
        });

        yield* buildAppUnderTest({ config: { baseDir: tempBaseDir } });

        const url = yield* getHttpServerUrl("/api/internal/thread-tools");
        const response = yield* Effect.promise(() =>
          fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-bigbud-thread-tool-token": THREAD_TOOL_TOKEN,
            },
            body: JSON.stringify({
              action: "computer_use",
              computerUseAction: { action: "capture" },
            }),
          }),
        );

        assert.equal(response.status, 200);
        const body = (yield* Effect.promise(() => response.json())) as {
          ok: boolean;
          result?: { summary?: string };
        };
        expect(body.ok).toBe(true);
        expect(body.result?.summary).toContain("Captured");
        expect(computerUse).toHaveBeenCalledWith({
          threadId: ThreadId.makeUnsafe(THREAD_ID),
          action: { action: "capture" },
        });
        expect(getThreadOrchestrationToolDispatcher()?.computerUse).toBe(computerUse);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
    );

    it.effect("rejects thread tool requests when the requested thread differs from the token", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tempBaseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-tools-auth-mismatch-",
        });
        const { stateDir } = yield* deriveServerPaths(tempBaseDir, undefined);
        const rename = vi.fn(() => Effect.succeed({ title: "Should not rename" }));

        yield* Effect.promise(() =>
          writeThreadOrchestrationToolAuth({
            stateDir,
            threadId: THREAD_ID,
            token: THREAD_TOOL_TOKEN,
          }),
        );

        setThreadOrchestrationToolDispatcher({
          rename,
          archive: () => Effect.succeed({ archived: true as const }),
          getStatus: () =>
            Effect.succeed({
              threadId: ThreadId.makeUnsafe(THREAD_ID),
              title: "Thread",
              workflowStatus: "idle",
              isAgentActive: false,
              isWorkflowComplete: false,
              sessionStatus: null,
              latestTurnState: null,
              latestTurnCompletedAt: null,
              hasPendingApprovals: false,
              hasPendingUserInput: false,
              hasActionableProposedPlan: false,
              lastAssistantExcerpt: null,
              updatedAt: new Date().toISOString(),
            }),
          computerUse: () =>
            Effect.succeed({
              surface: "browser" as const,
              action: "capture",
              summary: "Unused",
            }),
          browser: () => Effect.succeed({ action: "capture", summary: "Captured browser." }),
        });

        yield* buildAppUnderTest({ config: { baseDir: tempBaseDir } });

        const url = yield* getHttpServerUrl("/api/internal/thread-tools");
        const response = yield* Effect.promise(() =>
          fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-bigbud-thread-tool-token": THREAD_TOOL_TOKEN,
            },
            body: JSON.stringify({
              action: "rename",
              threadId: "thread-other",
              title: "Wrong thread",
            }),
          }),
        );

        assert.equal(response.status, 401);
        expect(rename).not.toHaveBeenCalled();
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
    );

    it.effect("allows get_status to inspect a different target thread as the caller", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tempBaseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-tools-status-target-",
        });
        const { stateDir } = yield* deriveServerPaths(tempBaseDir, undefined);
        const getStatus = vi.fn(({ threadId }: { callerThreadId: ThreadId; threadId: ThreadId }) =>
          Effect.succeed({
            threadId,
            title: "Other Thread",
            workflowStatus: "idle",
            isAgentActive: false,
            isWorkflowComplete: false,
            sessionStatus: null,
            latestTurnState: null,
            latestTurnCompletedAt: null,
            hasPendingApprovals: false,
            hasPendingUserInput: false,
            hasActionableProposedPlan: false,
            lastAssistantExcerpt: null,
            updatedAt: new Date().toISOString(),
          } satisfies ThreadWorkflowStatusSnapshot),
        );

        yield* Effect.promise(() =>
          writeThreadOrchestrationToolAuth({
            stateDir,
            threadId: THREAD_ID,
            token: THREAD_TOOL_TOKEN,
          }),
        );

        setThreadOrchestrationToolDispatcher({
          rename: () => Effect.succeed({ title: "Renamed" }),
          archive: () => Effect.succeed({ archived: true as const }),
          getStatus,
          computerUse: () =>
            Effect.succeed({
              surface: "browser" as const,
              action: "capture",
              summary: "Unused",
            }),
          browser: () => Effect.succeed({ action: "capture", summary: "Captured browser." }),
        });

        yield* buildAppUnderTest({ config: { baseDir: tempBaseDir } });

        const url = yield* getHttpServerUrl("/api/internal/thread-tools");
        const response = yield* Effect.promise(() =>
          fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-bigbud-thread-tool-token": THREAD_TOOL_TOKEN,
            },
            body: JSON.stringify({
              action: "get_status",
              threadId: "thread-other",
            }),
          }),
        );

        assert.equal(response.status, 200);
        const body = (yield* Effect.promise(() => response.json())) as {
          ok: boolean;
          status?: { threadId?: string };
        };
        expect(body.ok).toBe(true);
        expect(body.status?.threadId).toBe("thread-other");
        expect(getStatus).toHaveBeenCalledWith({
          callerThreadId: ThreadId.makeUnsafe(THREAD_ID),
          threadId: ThreadId.makeUnsafe("thread-other"),
        });
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
    );

    it.effect("requires rename requests to include the current thread ID", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tempBaseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-tools-rename-thread-id-",
        });
        const { stateDir } = yield* deriveServerPaths(tempBaseDir, undefined);
        const rename = vi.fn(() => Effect.succeed({ title: "Should not rename" }));

        yield* Effect.promise(() =>
          writeThreadOrchestrationToolAuth({
            stateDir,
            threadId: THREAD_ID,
            token: THREAD_TOOL_TOKEN,
          }),
        );

        setThreadOrchestrationToolDispatcher({
          rename,
          archive: () => Effect.succeed({ archived: true as const }),
          getStatus: () =>
            Effect.succeed({
              threadId: ThreadId.makeUnsafe(THREAD_ID),
              title: "Thread",
              workflowStatus: "idle",
              isAgentActive: false,
              isWorkflowComplete: false,
              sessionStatus: null,
              latestTurnState: null,
              latestTurnCompletedAt: null,
              hasPendingApprovals: false,
              hasPendingUserInput: false,
              hasActionableProposedPlan: false,
              lastAssistantExcerpt: null,
              updatedAt: new Date().toISOString(),
            }),
          computerUse: () =>
            Effect.succeed({
              surface: "browser" as const,
              action: "capture",
              summary: "Unused",
            }),
          browser: () => Effect.succeed({ action: "capture", summary: "Captured browser." }),
        });

        yield* buildAppUnderTest({ config: { baseDir: tempBaseDir } });

        const url = yield* getHttpServerUrl("/api/internal/thread-tools");
        const response = yield* Effect.promise(() =>
          fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-bigbud-thread-tool-token": THREAD_TOOL_TOKEN,
            },
            body: JSON.stringify({
              action: "rename",
              title: "Missing thread ID",
            }),
          }),
        );

        assert.equal(response.status, 400);
        expect(rename).not.toHaveBeenCalled();
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
    );
  });
});
