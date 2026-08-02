import {
  ProjectSummary,
  ProjectThreadCount,
  ThreadSummary,
  type ThreadSummary as ThreadSummaryType,
} from "@bigbud/contracts/orchestration/orchestration.catalog.ts";
import { ModelSelection } from "@bigbud/contracts/orchestration/orchestration.provider.ts";
import { NonNegativeInt } from "@bigbud/contracts/core/baseSchemas.ts";
import {
  ThreadDetailPendingApproval,
  ThreadDetailCheckpoint,
  ThreadDetailPendingUserInput,
} from "@bigbud/contracts/orchestration/orchestration.detail.ts";
import {
  OrchestrationProposedPlan,
  OrchestrationTask,
} from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { Schema, Struct } from "effect";

import { ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessage } from "../../persistence/Services/ProjectionThreadMessages.ts";

export const ProjectCatalogDbRow = ProjectSummary.mapFields(
  Struct.assign({
    hasExceptionalThreads: Schema.Number,
  }),
);
export type ProjectCatalogDbRow = typeof ProjectCatalogDbRow.Type;

export const ProjectThreadCountDbRow = ProjectThreadCount;

export const ThreadSummaryDbRow = ThreadSummary.mapFields(
  Struct.assign({
    modelSelection: Schema.fromJsonString(ModelSelection),
    isWatching: Schema.Number,
    isWatched: Schema.Number,
    isDelegated: Schema.Number,
    isAwaitingApproval: Schema.Number,
  }),
);
export type ThreadSummaryDbRow = typeof ThreadSummaryDbRow.Type;

export function normalizeThreadSummary(row: ThreadSummaryDbRow): ThreadSummaryType {
  return {
    ...row,
    modelSelection: row.modelSelection as ThreadSummaryType["modelSelection"],
    isWatching: row.isWatching === 1,
    isWatched: row.isWatched === 1,
    isDelegated: row.isDelegated === 1,
    isAwaitingApproval: row.isAwaitingApproval === 1,
  };
}

export const SidebarThreadSummaryDbRow = ThreadSummaryDbRow.mapFields(
  Struct.assign({
    isRecent: Schema.Number,
    isPinned: Schema.Number,
  }),
);
export type SidebarThreadSummaryDbRow = typeof SidebarThreadSummaryDbRow.Type;

export const ProjectionSequenceDbRow = Schema.Struct({
  projectionSequence: Schema.NullOr(NonNegativeInt),
});

export const ThreadDetailIdentityDbRow = Schema.Struct({
  projectId: ProjectSummary.fields.id,
  activityTurnId: Schema.NullOr(ThreadSummary.fields.activeTurnId),
});

export const ThreadDetailMessageDbRow = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    attachments: Schema.NullOr(Schema.fromJsonString(ProjectionThreadMessage.fields.attachments)),
    replyTo: Schema.NullOr(Schema.fromJsonString(ProjectionThreadMessage.fields.replyTo)),
  }),
);
export type ThreadDetailMessageDbRow = typeof ThreadDetailMessageDbRow.Type;

export const ThreadDetailActivityDbRow = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);
export type ThreadDetailActivityDbRow = typeof ThreadDetailActivityDbRow.Type;

export const ThreadDetailPendingApprovalDbRow = ThreadDetailPendingApproval;

export const ThreadDetailPendingUserInputDbRow = ThreadDetailPendingUserInput.mapFields(
  Struct.assign({
    questions: Schema.fromJsonString(ThreadDetailPendingUserInput.fields.questions),
    questionsTruncated: Schema.optional(Schema.Boolean),
  }),
);

export const ThreadDetailPlanDbRow = OrchestrationProposedPlan.mapFields(
  Struct.assign({ threadId: ThreadSummary.fields.id }),
);

export const ThreadDetailTaskDbRow = Schema.Struct({
  task: Schema.fromJsonString(OrchestrationTask),
});

export const ThreadDetailCheckpointDbRow = ThreadDetailCheckpoint;
