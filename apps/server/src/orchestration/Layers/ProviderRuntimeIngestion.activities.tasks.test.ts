import { describe, expect, it } from "vitest";

import {
  asEventId,
  asThreadId,
  asTurnId,
  createHarness,
  type ProviderRuntimeTestActivity,
  type ProviderRuntimeTestProposedPlan,
  registerProviderRuntimeIngestionTestCleanup,
  waitForThread,
} from "./ProviderRuntimeIngestion.test.helpers.ts";

describe("ProviderRuntimeIngestion", () => {
  registerProviderRuntimeIngestionTestCleanup();

  it("projects Codex task lifecycle chunks into thread activities", async () => {
    const harness = await createHarness({
      serverSettings: { enableThinkingStreaming: true },
    });
    const now = new Date().toISOString();

    harness.emit({
      type: "task.started",
      eventId: asEventId("evt-task-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        taskType: "plan",
      },
    });

    harness.emit({
      type: "task.progress",
      eventId: asEventId("evt-task-progress"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        description: "Comparing the desktop rollout chunks to the app-server stream.",
        summary: "Code reviewer is validating the desktop rollout chunks.",
      },
    });

    harness.emit({
      type: "task.progress",
      eventId: asEventId("evt-task-progress-repeat"),
      provider: "codex",
      createdAt: new Date(Date.parse(now) + 1_000).toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        description: "Comparing the desktop rollout chunks to the app-server stream.",
        summary: "Code reviewer completed the second validation pass.",
      },
    });

    harness.emit({
      type: "task.completed",
      eventId: asEventId("evt-task-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        status: "completed",
        summary: "<proposed_plan>\n# Plan title\n</proposed_plan>",
      },
    });
    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-task-proposed-plan-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        planMarkdown: "# Plan title",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "task.completed",
        ) &&
        entry.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-1:turn:turn-task-1",
        ),
    );

    const started = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "task:turn-task-1:started",
    );
    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "task:turn-task-1:progress",
    );
    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "task:turn-task-1:completed",
    );

    const progressPayload =
      progress?.payload && typeof progress.payload === "object"
        ? (progress.payload as Record<string, unknown>)
        : undefined;
    const completedPayload =
      completed?.payload && typeof completed.payload === "object"
        ? (completed.payload as Record<string, unknown>)
        : undefined;

    expect(started?.kind).toBe("task.started");
    expect(started?.summary).toBe("Plan task started");
    expect(progress?.kind).toBe("task.progress");
    expect(thread.activities.filter((activity) => activity.kind === "task.progress")).toHaveLength(
      1,
    );
    expect(progressPayload?.detail).toBe("Code reviewer completed the second validation pass.");
    expect(progressPayload?.summary).toBe("Code reviewer completed the second validation pass.");
    expect(completed?.kind).toBe("task.completed");
    expect(completedPayload?.detail).toBe("<proposed_plan>\n# Plan title\n</proposed_plan>");
    expect(
      thread.proposedPlans.find(
        (entry: ProviderRuntimeTestProposedPlan) => entry.id === "plan:thread-1:turn:turn-task-1",
      )?.planMarkdown,
    ).toBe("# Plan title");
    expect(thread.tasks).toEqual([
      expect.objectContaining({
        id: "turn-task-1",
        status: "completed",
        subject: "Comparing the desktop rollout chunks to the app-server stream.",
        progressSummary: "<proposed_plan>\n# Plan title\n</proposed_plan>",
      }),
    ]);
  });

  it("projects modern Claude task snapshots and their shared plan activity", async () => {
    const harness = await createHarness({
      serverSettings: { enableThinkingStreaming: true },
    });
    const now = new Date().toISOString();
    const threadId = asThreadId("thread-1");
    const turnId = asTurnId("turn-modern-claude-tasks");
    const freshness = {
      sessionEpoch: "claude-session-1",
      sourcePriority: 3,
      snapshotGeneration: 1,
      providerMessageId: "task-list-1",
      observedOrdinal: 1,
    } as const;

    harness.emit({
      type: "task.updated",
      eventId: asEventId("evt-claude-task-updated"),
      provider: "claudeAgent",
      createdAt: now,
      threadId,
      turnId,
      payload: {
        taskId: "task-1",
        status: "completed",
        subject: "Inspect files",
        source: "taskList",
        freshness,
        createdAt: now,
      },
    });
    harness.emit({
      type: "turn.plan.updated",
      eventId: asEventId("evt-claude-plan-updated"),
      provider: "claudeAgent",
      createdAt: now,
      threadId,
      turnId,
      payload: { plan: [{ step: "Inspect files", status: "completed" }] },
    });

    const updatedThread = await waitForThread(
      harness.engine,
      (entry) =>
        (entry.tasks ?? []).some((task) => task.id === "task-1") &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.id === "evt-claude-plan-updated",
        ),
    );
    expect(updatedThread.tasks).toEqual([
      expect.objectContaining({ id: "task-1", status: "completed", subject: "Inspect files" }),
    ]);
    expect(
      updatedThread.activities.find(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-claude-plan-updated",
      )?.payload,
    ).toEqual({ plan: [{ step: "Inspect files", status: "completed" }] });

    harness.emit({
      type: "task.removed",
      eventId: asEventId("evt-claude-task-removed"),
      provider: "claudeAgent",
      createdAt: new Date(Date.parse(now) + 1_000).toISOString(),
      threadId,
      turnId,
      payload: {
        taskId: "task-1",
        source: "taskList",
        freshness: { ...freshness, snapshotGeneration: 2, observedOrdinal: 2 },
        replacement: "snapshot",
      },
    });
    harness.emit({
      type: "turn.plan.updated",
      eventId: asEventId("evt-claude-plan-cleared"),
      provider: "claudeAgent",
      createdAt: new Date(Date.parse(now) + 1_000).toISOString(),
      threadId,
      turnId,
      payload: { plan: [] },
    });

    const clearedThread = await waitForThread(
      harness.engine,
      (entry) =>
        (entry.tasks ?? []).length === 0 &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.id === "evt-claude-plan-cleared",
        ),
    );
    expect(
      clearedThread.activities.find(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-claude-plan-cleared",
      )?.payload,
    ).toEqual({ plan: [] });
  });
});
