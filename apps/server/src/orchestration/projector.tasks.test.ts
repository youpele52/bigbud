import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { projectEvent } from "./projector.ts";
import { createEmptyReadModel } from "./projectorReadModel.ts";
import { makeEvent } from "./projector.test.helpers.ts";

const createdAt = "2026-07-25T00:00:00.000Z";

function threadCreatedEvent() {
  return makeEvent({
    sequence: 1,
    type: "thread.created",
    aggregateKind: "thread",
    aggregateId: "thread-1",
    occurredAt: createdAt,
    commandId: "create-thread",
    payload: {
      threadId: "thread-1",
      projectId: "project-1",
      title: "Task projection",
      modelSelection: { provider: "claudeAgent", model: "claude-sonnet" },
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt,
      updatedAt: createdAt,
    },
  });
}

function taskEvent(sequence: number, updatedAt: string, subject: string) {
  return makeEvent({
    sequence,
    type: "thread.task-upserted",
    aggregateKind: "thread",
    aggregateId: "thread-1",
    occurredAt: updatedAt,
    commandId: `task-${sequence}`,
    payload: {
      threadId: "thread-1",
      task: {
        id: "task-1",
        status: "inProgress",
        subject,
        sourceToolUseId: "tool-1",
        createdAt,
        updatedAt,
      },
    },
  });
}

describe("orchestration task projector", () => {
  it("rejects stale task updates while preserving the newest metadata", async () => {
    const initial = await Effect.runPromise(
      projectEvent(createEmptyReadModel(createdAt), threadCreatedEvent()),
    );
    const current = await Effect.runPromise(
      projectEvent(initial, taskEvent(2, "2026-07-25T00:00:02.000Z", "Current task")),
    );
    const stale = await Effect.runPromise(
      projectEvent(current, taskEvent(3, "2026-07-25T00:00:01.000Z", "Stale task")),
    );

    expect(stale.threads[0]?.tasks).toEqual(current.threads[0]?.tasks);
    expect(stale.threads[0]?.tasks?.[0]?.subject).toBe("Current task");
  });
});
