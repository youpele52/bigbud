import {
  CheckpointRef,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { deriveOrchestrationBatchEffects } from "./event-effects.logic";
import {
  getBatchFailedThreadDeletionToast,
  getFailedThreadDeletionToast,
  THREAD_DELETION_FAILED_TOAST_ID,
} from "./thread-deletion.logic";

function makeEvent<T extends OrchestrationEvent["type"]>(
  type: T,
  payload: Extract<OrchestrationEvent, { type: T }>["payload"],
  overrides: Partial<Extract<OrchestrationEvent, { type: T }>> = {},
): Extract<OrchestrationEvent, { type: T }> {
  const sequence = overrides.sequence ?? 1;
  return {
    sequence,
    eventId: EventId.makeUnsafe(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId:
      "threadId" in payload
        ? payload.threadId
        : "projectId" in payload
          ? payload.projectId
          : ProjectId.makeUnsafe("project-1"),
    occurredAt: "2026-02-27T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload,
    ...overrides,
  } as Extract<OrchestrationEvent, { type: T }>;
}

describe("deriveOrchestrationBatchEffects", () => {
  it("targets draft promotion and terminal cleanup from thread lifecycle events", () => {
    const createdThreadId = ThreadId.makeUnsafe("thread-created");
    const deletedThreadId = ThreadId.makeUnsafe("thread-deleted");
    const deletedDescendantThreadId = ThreadId.makeUnsafe("thread-deleted-descendant");
    const archivedThreadId = ThreadId.makeUnsafe("thread-archived");

    const effects = deriveOrchestrationBatchEffects([
      makeEvent("thread.created", {
        threadId: createdThreadId,
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Created thread",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
      }),
      makeEvent("thread.deletion-requested", {
        threadId: deletedThreadId,
        deletingAt: "2026-02-27T00:00:01.000Z",
      }),
      makeEvent("thread.deleted", {
        threadId: deletedThreadId,
        threadIds: [deletedThreadId, deletedDescendantThreadId],
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
      makeEvent("thread.archived", {
        threadId: archivedThreadId,
        archivedAt: "2026-02-27T00:00:02.000Z",
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
    ]);

    expect(effects.clearPromotedDraftThreadIds).toEqual([createdThreadId]);
    expect(effects.clearDeletedThreadIds).toEqual([deletedThreadId, deletedDescendantThreadId]);
    expect(effects.clearDeletedProjectIds).toEqual([]);
    expect(effects.removeSelectedThreadIds).toEqual([deletedThreadId, deletedDescendantThreadId]);
    expect(effects.removeTerminalStateThreadIds).toEqual([
      deletedThreadId,
      deletedDescendantThreadId,
      archivedThreadId,
    ]);
    expect(effects.failedDeleteThreadIds).toEqual([]);
    expect(effects.needsProviderInvalidation).toBe(false);
  });

  it("keeps only the final lifecycle outcome for a thread within one batch", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");

    const effects = deriveOrchestrationBatchEffects([
      makeEvent("thread.deleted", {
        threadId,
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
      makeEvent("thread.created", {
        threadId,
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Recreated thread",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: "2026-02-27T00:00:02.000Z",
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
      makeEvent("thread.turn-diff-completed", {
        threadId,
        turnId: TurnId.makeUnsafe("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
        status: "ready",
        files: [],
        assistantMessageId: MessageId.makeUnsafe("assistant-1"),
        completedAt: "2026-02-27T00:00:03.000Z",
      }),
    ]);

    expect(effects.clearPromotedDraftThreadIds).toEqual([threadId]);
    expect(effects.clearDeletedThreadIds).toEqual([]);
    expect(effects.clearDeletedProjectIds).toEqual([]);
    expect(effects.removeSelectedThreadIds).toEqual([]);
    expect(effects.removeTerminalStateThreadIds).toEqual([]);
    expect(effects.failedDeleteThreadIds).toEqual([]);
    expect(effects.needsProviderInvalidation).toBe(true);
  });

  it("does not retain archive cleanup when a thread is unarchived later in the same batch", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");

    const effects = deriveOrchestrationBatchEffects([
      makeEvent("thread.archived", {
        threadId,
        archivedAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      makeEvent("thread.unarchived", {
        threadId,
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
    ]);

    expect(effects.clearPromotedDraftThreadIds).toEqual([]);
    expect(effects.clearDeletedThreadIds).toEqual([]);
    expect(effects.clearDeletedProjectIds).toEqual([]);
    expect(effects.removeSelectedThreadIds).toEqual([]);
    expect(effects.removeTerminalStateThreadIds).toEqual([]);
    expect(effects.failedDeleteThreadIds).toEqual([]);
  });

  it("clears project-scoped drafts when a project is deleted", () => {
    const projectId = ProjectId.makeUnsafe("project-1");

    const effects = deriveOrchestrationBatchEffects([
      makeEvent("project.deleted", {
        projectId,
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
    ]);

    expect(effects.clearPromotedDraftThreadIds).toEqual([]);
    expect(effects.clearDeletedThreadIds).toEqual([]);
    expect(effects.clearDeletedProjectIds).toEqual([projectId]);
    expect(effects.removeSelectedThreadIds).toEqual([]);
    expect(effects.removeTerminalStateThreadIds).toEqual([]);
    expect(effects.failedDeleteThreadIds).toEqual([]);
  });

  it("does not treat deletion-requested as a completed delete", () => {
    const threadId = ThreadId.makeUnsafe("thread-deleting");
    const effects = deriveOrchestrationBatchEffects([
      makeEvent("thread.deletion-requested", {
        threadId,
        deletingAt: "2026-02-27T00:00:01.000Z",
      }),
    ]);

    expect(effects.clearDeletedThreadIds).toEqual([]);
    expect(effects.removeSelectedThreadIds).toEqual([]);
    expect(effects.removeTerminalStateThreadIds).toEqual([]);
    expect(effects.failedDeleteThreadIds).toEqual([]);
  });

  it("treats a later deletion failure as a restore, not a completed delete", () => {
    const threadId = ThreadId.makeUnsafe("thread-restored");
    const effects = deriveOrchestrationBatchEffects([
      makeEvent("thread.deletion-requested", {
        threadId,
        deletingAt: "2026-02-27T00:00:01.000Z",
      }),
      makeEvent("thread.deletion-failed", {
        threadId,
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
    ]);

    expect(effects.clearDeletedThreadIds).toEqual([]);
    expect(effects.removeSelectedThreadIds).toEqual([]);
    expect(effects.removeTerminalStateThreadIds).toEqual([]);
    expect(effects.failedDeleteThreadIds).toEqual([threadId]);
  });

  it("summarizes restored threads after a failed deletion with the server's reason", () => {
    const failure = (id: string, reason?: string) => ({
      threadId: ThreadId.makeUnsafe(id),
      reason,
    });
    expect(getFailedThreadDeletionToast([])).toBeNull();
    expect(getFailedThreadDeletionToast([failure("a", "Terminal cleanup failed: busy.")])).toEqual({
      id: THREAD_DELETION_FAILED_TOAST_ID,
      type: "error",
      title: "Thread was not deleted",
      description: "Terminal cleanup failed: busy.",
    });
    expect(getFailedThreadDeletionToast([failure("legacy")])?.description).toBe(
      "bigbud kept it after a safety check or cleanup failure.",
    );
    const batch = getFailedThreadDeletionToast(
      ["a", "b", "c", "d"].map((id) => failure(id, "Busy.")),
    );
    expect(batch?.title).toBe("4 threads were not deleted");
    expect(batch?.description).toBe("Busy.");
    expect(
      getFailedThreadDeletionToast([failure("a", "One."), failure("b", "Two.")])?.description,
    ).toBe("bigbud kept them after safety checks or cleanup failures. Open a thread to see why.");
  });

  it("shows one toast per batch and skips failures a Sidecar already explained", () => {
    const sidecar = ThreadId.makeUnsafe("sidecar");
    const other = ThreadId.makeUnsafe("other");
    const events = [
      makeEvent("thread.deletion-failed", {
        threadId: sidecar,
        reason: "Sidecar reason.",
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
      makeEvent("thread.deletion-failed", {
        threadId: other,
        reason: "Other reason.",
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
    ];
    const toast = getBatchFailedThreadDeletionToast({
      events,
      failedThreadIds: [sidecar, other],
      alreadyNotifiedThreadIds: new Set([sidecar]),
    });
    expect(toast).toMatchObject({ title: "Thread was not deleted", description: "Other reason." });
    expect(
      getBatchFailedThreadDeletionToast({
        events,
        failedThreadIds: [sidecar],
        alreadyNotifiedThreadIds: new Set([sidecar]),
      }),
    ).toBeNull();
  });
});
