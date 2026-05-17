import {
  ChatAttachment,
  IsoDateTime,
  MessageId,
  ModelSelection,
  NonNegativeInt,
  OrchestrationCheckpointFile,
  OrchestrationMessageReply,
  OrchestrationProposedPlanId,
  ParentThreadReference,
  ProjectId,
  ProjectScript,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";
import { Schema, Struct } from "effect";

import { ProjectionCheckpoint } from "../../persistence/Services/ProjectionCheckpoints.ts";
import { ProjectionProject } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionState } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessage } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlan } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSession } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionThread } from "../../persistence/Services/ProjectionThreads.ts";

export const ProjectionProjectDbRowSchema = ProjectionProject.mapFields(
  Struct.assign({
    defaultModelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
    scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
  }),
);

export const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
    replyTo: Schema.NullOr(Schema.fromJsonString(OrchestrationMessageReply)),
  }),
);

export const ProjectionThreadProposedPlanDbRowSchema = ProjectionThreadProposedPlan;

export const ProjectionThreadDbRowSchema = ProjectionThread.mapFields(
  Struct.assign({
    modelSelection: Schema.fromJsonString(ModelSelection),
    parentThread: Schema.NullOr(Schema.fromJsonString(ParentThreadReference)),
  }),
);

export const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);

export const ProjectionThreadSessionDbRowSchema = ProjectionThreadSession;

export const ProjectionCheckpointDbRowSchema = ProjectionCheckpoint.mapFields(
  Struct.assign({
    files: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
  }),
);

export const ProjectionLatestTurnDbRowSchema = Schema.Struct({
  threadId: ProjectionThread.fields.threadId,
  turnId: TurnId,
  state: Schema.String,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
});

export const ProjectionStateDbRowSchema = ProjectionState;

export const ProjectionCountsRowSchema = Schema.Struct({
  projectCount: Schema.Number,
  threadCount: Schema.Number,
});

export const WorkspaceRootLookupInput = Schema.Struct({
  workspaceRoot: Schema.String,
});

export const ProjectIdLookupInput = Schema.Struct({
  projectId: ProjectId,
});

export const ThreadIdLookupInput = Schema.Struct({
  threadId: ThreadId,
});

export const ProjectionProjectLookupRowSchema = ProjectionProjectDbRowSchema;

export const ProjectionThreadIdLookupRowSchema = Schema.Struct({
  threadId: ThreadId,
});

export const ProjectionThreadCheckpointContextThreadRowSchema = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  executionTargetId: ProjectionThread.fields.executionTargetId,
  workspaceRoot: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
});
