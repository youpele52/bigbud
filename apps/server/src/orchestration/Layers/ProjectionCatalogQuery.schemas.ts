import {
  ProjectSummary,
  ProjectThreadCount,
  ThreadSummary,
  type ThreadSummary as ThreadSummaryType,
} from "@bigbud/contracts/orchestration/orchestration.catalog.ts";
import { HistoricalModelSelection } from "@bigbud/contracts/orchestration/orchestration.provider.ts";
import { NonNegativeInt } from "@bigbud/contracts/core/baseSchemas.ts";
import { ThreadOrganization } from "@bigbud/contracts/orchestration/orchestration.organization.ts";
import {
  ThreadDetailPendingApproval,
  ThreadDetailCheckpoint,
  ThreadDetailPendingUserInput,
} from "@bigbud/contracts/orchestration/orchestration.detail.ts";
import {
  OrchestrationLatestTurn,
  OrchestrationProposedPlan,
  OrchestrationTask,
} from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { ThreadNotificationSafety } from "@bigbud/contracts/orchestration/orchestration.notificationSafety.ts";
import { ThreadRecovery } from "@bigbud/contracts/orchestration/orchestration.recovery.ts";
import { OrchestrationTurnControlOperation } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
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
    latestTurn: Schema.NullOr(Schema.fromJsonString(OrchestrationLatestTurn)),
    notificationSafety: Schema.fromJsonString(ThreadNotificationSafety),
    recovery: Schema.NullOr(Schema.fromJsonString(ThreadRecovery)),
    pendingTurnControlOperation: Schema.NullOr(
      Schema.fromJsonString(OrchestrationTurnControlOperation),
    ),
    modelSelection: Schema.fromJsonString(HistoricalModelSelection),
    organization: Schema.fromJsonString(ThreadOrganization),
    // projection_thread_sessions.retained_family; NULL when the thread has no session row.
    retainedFamily: Schema.NullOr(Schema.Number),
    isWatching: Schema.Number,
    isWatched: Schema.Number,
    isDelegated: Schema.Number,
    isAwaitingApproval: Schema.Number,
    isAwaitingUserInput: Schema.Number,
  }),
);
export type ThreadSummaryDbRow = typeof ThreadSummaryDbRow.Type;

export function normalizeThreadSummary(row: ThreadSummaryDbRow): ThreadSummaryType {
  return {
    ...row,
    modelSelection: row.modelSelection as ThreadSummaryType["modelSelection"],
    notificationSafety: {
      ...row.notificationSafety,
      overflow:
        row.notificationSafety.tasks.length >= 100 ||
        row.notificationSafety.childThreadIds.length >= 100 ||
        row.notificationSafety.pendingRequestIds.length >= 100 ||
        row.notificationSafety.queuedPromptIds.length >= 100 ||
        (row.notificationSafety.pendingFlush?.queuedPromptIds.length ?? 0) >= 100,
    },
    retainedFamily: row.retainedFamily === 1,
    isWatching: row.isWatching === 1,
    isWatched: row.isWatched === 1,
    isDelegated: row.isDelegated === 1,
    isAwaitingApproval: row.isAwaitingApproval === 1,
    isAwaitingUserInput: row.isAwaitingUserInput === 1,
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
    originSegments: Schema.NullOr(
      Schema.fromJsonString(ProjectionThreadMessage.fields.originSegments),
    ),
    /** Full stored length when selected with `boundedMessageTextColumnsSql`. */
    textLength: Schema.optional(NonNegativeInt),
  }),
);
export type ThreadDetailMessageDbRow = typeof ThreadDetailMessageDbRow.Type;

export const ThreadDetailActivityDbRow = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
    /** Stored payload length when selected with `boundedActivityPayloadColumnsSql`. */
    payloadLength: Schema.optional(Schema.NullOr(NonNegativeInt)),
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
