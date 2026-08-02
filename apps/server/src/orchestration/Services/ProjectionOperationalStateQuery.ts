import type { OrchestrationReadModel, ThreadId } from "@bigbud/contracts";
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
}

export class ProjectionOperationalStateQuery extends ServiceMap.Service<
  ProjectionOperationalStateQuery,
  ProjectionOperationalStateQueryShape
>()("bigbud/orchestration/Services/ProjectionOperationalStateQuery") {}
