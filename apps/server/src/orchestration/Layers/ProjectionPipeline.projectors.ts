/**
 * ProjectionPipeline projectors — projector factory functions.
 *
 * Each `apply` function is a pure projector that receives repository
 * instances as deps and handles the relevant `OrchestrationEvent` cases.
 *
 * @module ProjectionPipeline.projectors
 */
import { type OrchestrationEvent } from "@bigbud/contracts";
import { Effect } from "effect";

import { type ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { type ProjectionProjectRepositoryShape } from "../../persistence/Services/ProjectionProjects.ts";
import { type ProjectionThreadRepositoryShape } from "../../persistence/Services/ProjectionThreads.ts";
import { type ProjectionThreadMessageRepositoryShape } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { type ProjectionThreadProposedPlanRepositoryShape } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { type ProjectionThreadActivityRepositoryShape } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { type ProjectionThreadSessionRepositoryShape } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { type ProjectionTurnRepositoryShape } from "../../persistence/Services/ProjectionTurns.ts";
import { type ProjectionPendingApprovalRepositoryShape } from "../../persistence/Services/ProjectionPendingApprovals.ts";
import {
  type AttachmentSideEffects,
  ORCHESTRATION_PROJECTOR_NAMES,
} from "./ProjectionPipeline.helpers.ts";
import { makeProjectsProjector } from "./ProjectionPipeline.projector.projects.ts";
import { makeThreadsProjector } from "./ProjectionPipeline.projector.threads.ts";
import { makeThreadMessagesProjector } from "./ProjectionPipeline.projector.threadMessages.ts";
import { makeThreadProposedPlansProjector } from "./ProjectionPipeline.projector.threadProposedPlans.ts";
import { makeThreadActivitiesProjector } from "./ProjectionPipeline.projector.threadActivities.ts";
import { makeThreadSessionsProjector } from "./ProjectionPipeline.projector.threadSessions.ts";
import { makeThreadTurnsProjector } from "./ProjectionPipeline.projector.threadTurns.ts";
import { makePendingApprovalsProjector } from "./ProjectionPipeline.projector.pendingApprovals.ts";

export type ProjectorApplyFn = (
  event: OrchestrationEvent,
  attachmentSideEffects: AttachmentSideEffects,
) => Effect.Effect<void, ProjectionRepositoryError>;

export interface ProjectorDefinition {
  readonly name: (typeof ORCHESTRATION_PROJECTOR_NAMES)[keyof typeof ORCHESTRATION_PROJECTOR_NAMES];
  readonly apply: ProjectorApplyFn;
}

export interface ProjectorDeps {
  readonly projectionProjectRepository: ProjectionProjectRepositoryShape;
  readonly projectionThreadRepository: ProjectionThreadRepositoryShape;
  readonly projectionThreadMessageRepository: ProjectionThreadMessageRepositoryShape;
  readonly projectionThreadProposedPlanRepository: ProjectionThreadProposedPlanRepositoryShape;
  readonly projectionThreadActivityRepository: ProjectionThreadActivityRepositoryShape;
  readonly projectionThreadSessionRepository: ProjectionThreadSessionRepositoryShape;
  readonly projectionTurnRepository: ProjectionTurnRepositoryShape;
  readonly projectionPendingApprovalRepository: ProjectionPendingApprovalRepositoryShape;
}

/** Build all 9 projector definitions from their repository dependencies. */
export function makeProjectors(deps: ProjectorDeps): ReadonlyArray<ProjectorDefinition> {
  return [
    makeProjectsProjector(deps),
    makeThreadMessagesProjector(deps),
    makeThreadProposedPlansProjector(deps),
    makeThreadActivitiesProjector(deps),
    makeThreadSessionsProjector(deps),
    makeThreadTurnsProjector(deps),
    { name: ORCHESTRATION_PROJECTOR_NAMES.checkpoints, apply: () => Effect.void },
    makePendingApprovalsProjector(deps),
    makeThreadsProjector(deps),
  ];
}
