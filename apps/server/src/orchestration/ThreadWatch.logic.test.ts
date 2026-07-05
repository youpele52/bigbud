import { MessageId, ThreadId, type OrchestrationThread } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  buildThreadWatchTriggerPrompt,
  extractWatchedThreadAttachments,
  groupActiveWatchesByTriggerKey,
  isThreadWorkflowComplete,
  isWatcherThreadBusy,
} from "./ThreadWatch.logic.ts";
import { resolveThreadWorkflowStatus } from "./ThreadWorkflowStatus.logic.ts";

const WATCHER_THREAD_ID = ThreadId.makeUnsafe("watcher-thread");
const WATCHED_THREAD_ID = ThreadId.makeUnsafe("watched-thread");
const MESSAGE_ID = MessageId.makeUnsafe("message-1");

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: WATCHED_THREAD_ID,
    projectId: "project-1" as never,
    title: "Watched thread",
    elevatorSummary: "Watched thread",
    elevatorSummaryMessageCount: 0,
    modelSelection: { provider: "codex" as const, model: "gpt-5" },
    runtimeMode: "approval-required" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: "turn-1" as never,
      state: "completed" as const,
      requestedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:01.000Z",
      completedAt: "2026-01-01T00:00:02.000Z",
      assistantMessageId: "assistant-1" as never,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:02.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: {
      threadId: WATCHED_THREAD_ID,
      status: "ready" as const,
      providerName: "codex",
      runtimeMode: "approval-required",
      activeTurnId: null,
      reason: null,
      lastError: null,
      updatedAt: "2026-01-01T00:00:02.000Z",
    },
    watchingThreads: [],
    ...overrides,
  };
}

describe("ThreadWatch.logic", () => {
  it("extracts only watched thread attachments from other threads", () => {
    const attachments = [
      {
        type: "thread" as const,
        id: "ref-1",
        name: "A",
        mimeType: "application/x-bigbud-thread-reference" as const,
        sizeBytes: 0 as const,
        threadId: WATCHED_THREAD_ID,
        title: "A",
        watchForCompletion: true,
      },
      {
        type: "thread" as const,
        id: "ref-2",
        name: "Self",
        mimeType: "application/x-bigbud-thread-reference" as const,
        sizeBytes: 0 as const,
        threadId: WATCHER_THREAD_ID,
        title: "Self",
        watchForCompletion: true,
      },
      {
        type: "thread" as const,
        id: "ref-3",
        name: "B",
        mimeType: "application/x-bigbud-thread-reference" as const,
        sizeBytes: 0 as const,
        threadId: ThreadId.makeUnsafe("other-thread"),
        title: "B",
        watchForCompletion: false,
      },
    ];

    expect(extractWatchedThreadAttachments(attachments, WATCHER_THREAD_ID)).toEqual([
      attachments[0],
    ]);
  });

  it("detects workflow completion and busy watcher state", () => {
    const completedThread = makeThread();
    expect(isThreadWorkflowComplete(completedThread)).toBe(true);
    expect(isWatcherThreadBusy(completedThread)).toBe(false);

    const runningThread = makeThread({
      session: {
        threadId: WATCHED_THREAD_ID,
        status: "running",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: "turn-2" as never,
        reason: null,
        lastError: null,
        updatedAt: "2026-01-01T00:00:03.000Z",
      },
    });
    expect(isThreadWorkflowComplete(runningThread)).toBe(false);
    expect(isWatcherThreadBusy(runningThread)).toBe(true);
  });

  it("groups watches by watcher and source message", () => {
    const grouped = groupActiveWatchesByTriggerKey([
      {
        watcherThreadId: WATCHER_THREAD_ID,
        sourceMessageId: MESSAGE_ID,
        watchedThreadId: WATCHED_THREAD_ID,
      },
      {
        watcherThreadId: WATCHER_THREAD_ID,
        sourceMessageId: MESSAGE_ID,
        watchedThreadId: ThreadId.makeUnsafe("watched-thread-2"),
      },
    ]);

    expect(grouped.size).toBe(1);
    expect(grouped.get(`${WATCHER_THREAD_ID}:${MESSAGE_ID}`)?.length).toBe(2);
  });

  it("builds a trigger prompt with completed thread status", () => {
    const thread = makeThread();
    const status = resolveThreadWorkflowStatus(thread);
    const prompt = buildThreadWatchTriggerPrompt({
      completedThreads: [
        {
          title: thread.title,
          threadId: thread.id,
          status,
        },
      ],
    });

    expect(prompt).toContain("<watched_threads_completed>");
    expect(prompt).toContain("Watched thread");
    expect(prompt).toContain(status.workflowStatus);
    expect(prompt).toContain("get_thread_status");
  });
});
