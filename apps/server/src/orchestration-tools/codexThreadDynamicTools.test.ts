import { MessageId, ThreadId, TurnId } from "@bigbud/contracts";
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
          name: "create_thread",
          inputSchema: expect.objectContaining({
            required: ["title", "task"],
          }),
        }),
        expect.objectContaining({
          namespace: "bigbud_orchestration",
          name: "get_thread_status",
        }),
        expect.objectContaining({
          namespace: "bigbud_orchestration",
          name: "list_pinned_threads",
        }),
        expect.objectContaining({
          namespace: "bigbud_orchestration",
          name: "pin_thread",
          description: expect.stringContaining(
            "Only use this when the user explicitly asks to pin a thread.",
          ),
        }),
        expect.objectContaining({
          namespace: "bigbud_orchestration",
          name: "unpin_thread",
          description: expect.stringContaining(
            "Only use this when the user explicitly asks to unpin a thread.",
          ),
        }),
        expect.objectContaining({
          namespace: "bigbud_orchestration",
          name: "computer_use",
        }),
        expect.objectContaining({
          namespace: "bigbud_orchestration",
          name: "browser",
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
      listPinned: (input) => {
        calls.push({ kind: "list_pinned", ...input });
        return Effect.succeed({ count: 1, limit: 5, remaining: 4, threads: [] });
      },
      setPinned: (input) => {
        calls.push({ kind: "set_pinned", ...input });
        return Effect.succeed({
          threadId: input.threadId,
          pinned: input.pinned,
          pinnedAt: input.pinned ? new Date().toISOString() : null,
          count: input.pinned ? 1 : 0,
          limit: 5,
          remaining: input.pinned ? 4 : 5,
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
      browser: (input) => {
        calls.push({ kind: "browser", ...input });
        return Effect.succeed({ action: "capture", summary: "Captured the in-app browser." });
      },
      createThread: (input) => {
        calls.push({ kind: "create_thread", ...input });
        return Effect.succeed({
          accepted: true as const,
          replayed: false as const,
          childThreadId: ThreadId.makeUnsafe("child"),
          childTurnId: TurnId.makeUnsafe("child-turn"),
          createSequence: 1,
          turnSequence: 2,
          watchForCompletion: input.watchForCompletion,
          observedStatus: null,
        });
      },
    };

    setThreadOrchestrationToolDispatcher(dispatcher);

    try {
      const threadId = ThreadId.makeUnsafe("thread-codex-dynamic");
      const handler = createCodexThreadOrchestrationDynamicToolHandler(threadId);

      const createResult = await handler({
        namespace: "bigbud_orchestration",
        tool: "create_thread",
        requestId: 17,
        sourceMessageId: "source-message",
        arguments: { title: "Side chat", task: "Investigate this", watchForCompletion: true },
      });
      expect(createResult).toEqual({
        contentItems: [
          {
            type: "inputText",
            text: expect.stringContaining('"accepted": true'),
          },
        ],
        success: true,
      });

      const renameResult = await handler({
        namespace: "bigbud_orchestration",
        tool: "rename_thread",
        requestId: 18,
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
        requestId: 19,
        arguments: { threadId: "thread-other" },
      });
      expect(statusResult.success).toBe(true);
      expect(statusResult.contentItems[0]).toEqual(
        expect.objectContaining({
          type: "inputText",
          text: expect.stringContaining('"threadId": "thread-other"'),
        }),
      );

      await handler({
        namespace: "bigbud_orchestration",
        tool: "list_pinned_threads",
        requestId: 20,
        arguments: {},
      });

      await handler({
        namespace: "bigbud_orchestration",
        tool: "pin_thread",
        requestId: 21,
        arguments: { threadId: "thread-pinned" },
      });

      await handler({
        namespace: "bigbud_orchestration",
        tool: "browser",
        requestId: 22,
        arguments: { action: "capture" },
      });

      expect(calls).toEqual([
        {
          kind: "create_thread",
          callerThreadId: threadId,
          sourceMessageId: MessageId.makeUnsafe("source-message"),
          invocationId: "17",
          title: "Side chat",
          task: "Investigate this",
          watchForCompletion: true,
        },
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
        {
          kind: "list_pinned",
          callerThreadId: threadId,
        },
        {
          kind: "set_pinned",
          callerThreadId: threadId,
          threadId: ThreadId.makeUnsafe("thread-pinned"),
          pinned: true,
        },
        {
          kind: "browser",
          threadId,
          action: { action: "capture" },
        },
      ]);
    } finally {
      setThreadOrchestrationToolDispatcher(null);
    }
  });
});
