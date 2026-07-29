import { RuntimeTaskId, ThreadId, type OrchestrationEvent } from "@bigbud/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { makeThreadTasksProjector } from "./ProjectionPipeline.projector.tasks.ts";
import { makeEvent } from "../projector.test.helpers.ts";
import type { ProjectionThreadTask } from "../../persistence/Services/ProjectionThreadTasks.ts";

const threadId = ThreadId.makeUnsafe("thread-1");
const taskId = RuntimeTaskId.makeUnsafe("task-1");
const baseTask: ProjectionThreadTask["task"] = {
  id: taskId,
  status: "inProgress",
  subject: "Keep metadata",
  requestId: "request-1",
  source: "observed",
  freshness: { sessionEpoch: "epoch-1", sourcePriority: 1, observedOrdinal: 1 },
  createdAt: "2026-07-25T00:00:00.000Z",
  updatedAt: "2026-07-25T00:00:01.000Z",
};

function repository() {
  let current: ProjectionThreadTask | undefined;
  return {
    getByTaskId: () => Effect.succeed(current ? Option.some(current) : Option.none()),
    listByThreadId: () => Effect.succeed(current ? [current] : []),
    upsert: (row: ProjectionThreadTask) =>
      Effect.sync(() => {
        current = row;
      }),
    remove: () =>
      Effect.sync(() => {
        current = undefined;
      }),
    deleteByThreadId: () =>
      Effect.sync(() => {
        current = undefined;
      }),
    get: () => current,
  };
}

function upsertEvent(task: typeof baseTask, sequence: number): OrchestrationEvent {
  return makeEvent({
    sequence,
    type: "thread.task-upserted",
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: task.updatedAt,
    commandId: `command-${sequence}`,
    payload: { threadId, task },
  });
}

describe("durable task projector", () => {
  it("merges omitted metadata and rejects stale freshness", async () => {
    const store = repository();
    const projector = makeThreadTasksProjector({
      projectionThreadTaskRepository: store,
    });
    await Effect.runPromise(
      projector.apply(upsertEvent(baseTask, 1), {
        deletedThreadIds: new Set(),
        deletedProjectMemoryIds: new Set(),
        prunedThreadRelativePaths: new Map(),
      }),
    );
    await Effect.runPromise(
      projector.apply(
        upsertEvent(
          {
            ...baseTask,
            subject: "New subject",
            freshness: { ...baseTask.freshness, observedOrdinal: 2 },
            updatedAt: "2026-07-25T00:00:02.000Z",
          },
          2,
        ),
        {
          deletedThreadIds: new Set(),
          deletedProjectMemoryIds: new Set(),
          prunedThreadRelativePaths: new Map(),
        },
      ),
    );
    expect(store.get()?.task).toMatchObject({ subject: "New subject", requestId: "request-1" });
    await Effect.runPromise(
      projector.apply(
        upsertEvent({ ...baseTask, subject: "Stale", updatedAt: "2026-07-25T00:00:00.500Z" }, 3),
        {
          deletedThreadIds: new Set(),
          deletedProjectMemoryIds: new Set(),
          prunedThreadRelativePaths: new Map(),
        },
      ),
    );
    expect(store.get()?.task.subject).toBe("New subject");
  });
});
