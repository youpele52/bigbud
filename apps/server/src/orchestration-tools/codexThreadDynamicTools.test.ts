import { ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import {
  createCodexThreadOrchestrationDynamicToolHandler,
  createCodexThreadOrchestrationDynamicTools,
} from "./codexThreadDynamicTools.ts";
import {
  setThreadOrchestrationToolDispatcher,
  type ThreadOrchestrationToolDispatcherShape,
} from "./ThreadOrchestrationToolDispatcher.ts";

describe("codexThreadDynamicTools", () => {
  it("defines the thread orchestration dynamic tools", () => {
    expect(createCodexThreadOrchestrationDynamicTools()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          namespace: "bigbud_orchestration",
          name: "rename_thread",
        }),
        expect.objectContaining({
          namespace: "bigbud_orchestration",
          name: "archive_thread",
        }),
        expect.objectContaining({
          namespace: "bigbud_orchestration",
          name: "get_thread_status",
        }),
        expect.objectContaining({
          namespace: "bigbud_orchestration",
          name: "computer_use",
        }),
      ]),
    );
  });

  it("routes dynamic tool calls through the thread tool dispatcher", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const dispatcher: ThreadOrchestrationToolDispatcherShape = {
      rename: (input) => {
        calls.push({ kind: "rename", ...input });
        return Effect.succeed({ title: input.title });
      },
      archive: (input) => {
        calls.push({ kind: "archive", ...input });
        return Effect.succeed({ archived: true as const });
      },
      getStatus: (input) => {
        calls.push({ kind: "status", ...input });
        return Effect.succeed({
          threadId: input.threadId,
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
        });
      },
      computerUse: (input) => {
        calls.push({ kind: "computer_use", ...input });
        return Effect.succeed({
          surface: "browser",
          action: "capture",
          summary: "Captured the current page.",
        });
      },
    };

    setThreadOrchestrationToolDispatcher(dispatcher);

    try {
      const threadId = ThreadId.makeUnsafe("thread-codex-dynamic");
      const handler = createCodexThreadOrchestrationDynamicToolHandler(threadId);

      const renameResult = await handler({
        namespace: "bigbud_orchestration",
        tool: "rename_thread",
        arguments: { title: "Renamed" },
      });
      expect(renameResult.success).toBe(true);
      expect(renameResult.contentItems[0]).toEqual({
        type: "inputText",
        text: 'Renamed thread to "Renamed".',
      });

      const statusResult = await handler({
        namespace: "bigbud_orchestration",
        tool: "get_thread_status",
        arguments: { threadId: "thread-other" },
      });
      expect(statusResult.success).toBe(true);
      expect(statusResult.contentItems[0]).toEqual(
        expect.objectContaining({
          type: "inputText",
          text: expect.stringContaining('"threadId": "thread-other"'),
        }),
      );

      expect(calls).toEqual([
        {
          kind: "rename",
          threadId,
          title: "Renamed",
        },
        {
          kind: "status",
          callerThreadId: threadId,
          threadId: ThreadId.makeUnsafe("thread-other"),
        },
      ]);
    } finally {
      setThreadOrchestrationToolDispatcher(null);
    }
  });
});
