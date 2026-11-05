import {
  OrchestrationQueuedPrompt,
  OrchestrationPendingInterruptFlushIntent,
  OrchestrationTurnControlOperation,
  ParentThreadReference,
  PersistedModelSelection,
} from "@bigbud/contracts";
import { OrchestrationPendingTurnStart } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { ProjectionThread } from "../Services/ProjectionThreads.ts";

/** SQL row shapes of `projection_threads` and their normalization to `ProjectionThread`. */
export const ProjectionThreadDbRow = ProjectionThread.mapFields(
  Struct.assign({
    // Keep historical provider selections readable after a provider is removed.
    modelSelection: Schema.fromJsonString(PersistedModelSelection),
    parentThread: Schema.NullOr(Schema.fromJsonString(ParentThreadReference)),
    queuedPrompts: Schema.fromJsonString(Schema.Array(OrchestrationQueuedPrompt)),
    pendingInterruptFlushIntent: Schema.NullOr(
      Schema.fromJsonString(OrchestrationPendingInterruptFlushIntent),
    ),
    pendingTurnControlOperation: Schema.NullOr(
      Schema.fromJsonString(OrchestrationTurnControlOperation),
    ),
    queueHold: Schema.Number,
    pendingTurnStart: Schema.NullOr(Schema.fromJsonString(OrchestrationPendingTurnStart)),
  }),
);
export type ProjectionThreadDbRow = typeof ProjectionThreadDbRow.Type;

export const ProjectionThreadWriteRow = ProjectionThread.mapFields(
  Struct.assign({
    worktreeIdentity: Schema.NullOr(
      Schema.Struct({
        canonicalPath: Schema.String,
        device: Schema.Number,
        inode: Schema.Number,
      }),
    ),
  }),
);

export function normalizeProjectionThreadRow(
  row: ProjectionThreadDbRow,
): typeof ProjectionThread.Type {
  return {
    threadId: row.threadId,
    projectId: row.projectId,
    title: row.title,
    purpose: row.purpose,
    elevatorSummary: row.elevatorSummary,
    elevatorSummaryMessageCount: row.elevatorSummaryMessageCount,
    providerRuntimeExecutionTargetId: row.providerRuntimeExecutionTargetId,
    workspaceExecutionTargetId: row.workspaceExecutionTargetId,
    executionTargetId: row.executionTargetId,
    modelSelection: row.modelSelection as ProjectionThread["modelSelection"],
    runtimeMode: row.runtimeMode,
    interactionMode: row.interactionMode,
    branch: row.branch,
    worktreePath: row.worktreePath,
    ...(row.parentThread !== null ? { parentThread: row.parentThread } : {}),
    latestTurnId: row.latestTurnId,
    queuedPrompts: row.queuedPrompts,
    ...(row.pendingInterruptFlushIntent !== undefined
      ? { pendingInterruptFlushIntent: row.pendingInterruptFlushIntent }
      : {}),
    pendingTurnControlOperation: row.pendingTurnControlOperation ?? null,
    queueHold: row.queueHold === 1,
    pendingTurnStart: row.pendingTurnStart,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastActivityAt: row.lastActivityAt,
    archivedAt: row.archivedAt,
    pinnedAt: row.pinnedAt,
    deletingAt: row.deletingAt,
    deletedAt: row.deletedAt,
  };
}
