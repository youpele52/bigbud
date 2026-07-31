import type {
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationTask,
  ThreadId,
} from "@bigbud/contracts";
import {
  compareTaskOrder,
  isTaskFreshnessNewer,
  mergeTaskPatch,
} from "@bigbud/shared/providerRuntime";
import { Effect } from "effect";

import type { OrchestrationProjectorDecodeError } from "./Errors.ts";
import { ThreadTaskRemovedPayload, ThreadTaskUpsertedPayload } from "./Schemas.ts";
import { decodeForEvent, updateThread } from "./projectorHelpers.ts";

const MAX_THREAD_TASKS = 500;

function ordered(tasks: ReadonlyArray<OrchestrationTask>) {
  return tasks.toSorted(compareTaskOrder).slice(-MAX_THREAD_TASKS);
}

function updateTasks(
  model: OrchestrationReadModel,
  threadId: ThreadId,
  tasks: ReadonlyArray<OrchestrationTask>,
  updatedAt: string,
) {
  return {
    ...model,
    threads: updateThread(model.threads, threadId, { tasks, updatedAt }),
  };
}

export function projectThreadTaskEvent(
  nextBase: OrchestrationReadModel,
  event: Extract<OrchestrationEvent, { type: "thread.task-upserted" | "thread.task-removed" }>,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  if (event.type === "thread.task-removed") {
    return decodeForEvent(ThreadTaskRemovedPayload, event.payload, event.type, "payload").pipe(
      Effect.map((payload) => {
        const current =
          nextBase.threads.find((thread) => thread.id === payload.threadId)?.tasks ?? [];
        const existing = current.find((task) => task.id === payload.taskId);
        return existing && !isTaskFreshnessNewer(payload.freshness, existing.freshness)
          ? nextBase
          : updateTasks(
              nextBase,
              payload.threadId,
              current.filter((task) => task.id !== payload.taskId),
              event.occurredAt,
            );
      }),
    );
  }
  return decodeForEvent(ThreadTaskUpsertedPayload, event.payload, event.type, "payload").pipe(
    Effect.map((payload) => {
      const current =
        nextBase.threads.find((thread) => thread.id === payload.threadId)?.tasks ?? [];
      const existing = current.find((task) => task.id === payload.task.id);
      if (existing && !isTaskFreshnessNewer(payload.task.freshness, existing.freshness))
        return nextBase;
      const task = existing ? mergeTaskPatch(existing, payload.task) : payload.task;
      return updateTasks(
        nextBase,
        payload.threadId,
        ordered([...current.filter((entry) => entry.id !== task.id), task]),
        event.occurredAt,
      );
    }),
  );
}
