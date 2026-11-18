import type { OrchestrationReadModel, ProjectId, ThreadId } from "@bigbud/contracts";
import { ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface ProjectionOperationalStateQueryShape {
  readonly getStartupOperationalState: () => Effect.Effect<
    OrchestrationReadModel,
    ProjectionRepositoryError
  >;
  readonly getThreadOperationalState: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationReadModel>, ProjectionRepositoryError>;
  /** Reads complete persisted projection history for one explicit thread operation. */
  readonly getFullThreadHistory: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationReadModel>, ProjectionRepositoryError>;
  /** Reads one project (without threads), deleted or not; none when it was never projected. */
  readonly getProjectOperationalState: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<OrchestrationReadModel>, ProjectionRepositoryError>;
  /** Ids of a project's threads that are not deleted, in creation order. */
  readonly listProjectThreadIds: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<ThreadId>, ProjectionRepositoryError>;
  /** Ids of the projects that are not deleted and use this workspace root. */
  readonly listProjectIdsByWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<ReadonlyArray<ProjectId>, ProjectionRepositoryError>;
}

export class ProjectionOperationalStateQuery extends ServiceMap.Service<
  ProjectionOperationalStateQuery,
  ProjectionOperationalStateQueryShape
>()("bigbud/orchestration/Services/ProjectionOperationalStateQuery") {}
