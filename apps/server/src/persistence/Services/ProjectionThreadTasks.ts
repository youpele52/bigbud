import { OrchestrationTask, RuntimeTaskId, ThreadId } from "@bigbud/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";
import type { Option } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadTask = Schema.Struct({
  taskId: RuntimeTaskId,
  threadId: ThreadId,
  task: OrchestrationTask,
});
export type ProjectionThreadTask = typeof ProjectionThreadTask.Type;

export const ProjectionThreadTaskLookup = Schema.Struct({ taskId: RuntimeTaskId });
export type ProjectionThreadTaskLookup = typeof ProjectionThreadTaskLookup.Type;

export const ProjectionThreadTasksByThread = Schema.Struct({ threadId: ThreadId });
export type ProjectionThreadTasksByThread = typeof ProjectionThreadTasksByThread.Type;

export interface ProjectionThreadTaskRepositoryShape {
  readonly upsert: (row: ProjectionThreadTask) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getByTaskId: (
    input: ProjectionThreadTaskLookup,
  ) => Effect.Effect<Option.Option<ProjectionThreadTask>, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ProjectionThreadTasksByThread,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadTask>, ProjectionRepositoryError>;
  readonly remove: (
    input: ProjectionThreadTaskLookup,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: ProjectionThreadTasksByThread,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadTaskRepository extends ServiceMap.Service<
  ProjectionThreadTaskRepository,
  ProjectionThreadTaskRepositoryShape
>()("bigbud/persistence/Services/ProjectionThreadTasks/ProjectionThreadTaskRepository") {}
