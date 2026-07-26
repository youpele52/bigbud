import { type OrchestrationEvent } from "@bigbud/contracts";
import { isTaskFreshnessNewer, mergeTaskPatch } from "@bigbud/shared/providerRuntime";
import { Effect, Option } from "effect";
import {
  ORCHESTRATION_PROJECTOR_NAMES,
  type AttachmentSideEffects,
} from "./ProjectionPipeline.helpers.ts";
import { type ProjectorDefinition, type ProjectorDeps } from "./ProjectionPipeline.projectors.ts";

export function makeThreadTasksProjector(
  deps: Pick<ProjectorDeps, "projectionThreadTaskRepository">,
): ProjectorDefinition {
  const repository = deps.projectionThreadTaskRepository;
  const apply = Effect.fn("applyThreadTasksProjection")(function* (
    event: OrchestrationEvent,
    _sideEffects: AttachmentSideEffects,
  ) {
    if (event.type === "thread.task-upserted") {
      const existing = yield* repository.getByTaskId({ taskId: event.payload.task.id });
      if (
        Option.isSome(existing) &&
        !isTaskFreshnessNewer(event.payload.task.freshness, existing.value.task.freshness)
      )
        return;
      const task = Option.isSome(existing)
        ? mergeTaskPatch(existing.value.task, event.payload.task)
        : event.payload.task;
      yield* repository.upsert({ taskId: task.id, threadId: event.payload.threadId, task });
      return;
    }
    if (event.type === "thread.task-removed") {
      const existing = yield* repository.getByTaskId({ taskId: event.payload.taskId });
      if (
        Option.isNone(existing) ||
        isTaskFreshnessNewer(event.payload.freshness, existing.value.task.freshness)
      ) {
        yield* repository.remove({ taskId: event.payload.taskId });
      }
      return;
    }
    if (event.type === "thread.deleted") {
      yield* repository.deleteByThreadId({ threadId: event.payload.threadId });
    }
  });
  return { name: ORCHESTRATION_PROJECTOR_NAMES.threadTasks, apply };
}
