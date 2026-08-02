import { Option, Schema, SchemaIssue, Struct } from "effect";
import {
  CheckpointRef,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "../core/baseSchemas";
import { ProviderApprovalDecision } from "./orchestration.provider";
import { ClientOrchestrationCommand } from "./orchestration.commands";
import { OrchestrationEvent } from "./orchestration.events";
import { OrchestrationReadModel } from "./orchestration.thread";
import { OrchestrationCheckpointFile, OrchestrationCheckpointStatus } from "./orchestration.thread";
import { OrchestrationThread } from "./orchestration.thread";
import {
  GetProjectThreadSummariesInput,
  GetProjectThreadSummariesResult,
  GetSidebarThreadCatalogInput,
  GetSidebarThreadCatalogResult,
  GetStartupProjectCatalogInput,
  GetStartupProjectCatalogResult,
} from "./orchestration.catalog";
import {
  GetSelectedThreadDetailInput,
  GetSelectedThreadDetailResult,
} from "./orchestration.detail";

export const OrchestrationCommandReceiptStatus = Schema.Literals(["accepted", "rejected"]);
export type OrchestrationCommandReceiptStatus = typeof OrchestrationCommandReceiptStatus.Type;

export const TurnCountRange = Schema.Struct({
  fromTurnCount: NonNegativeInt,
  toTurnCount: NonNegativeInt,
}).check(
  Schema.makeFilter(
    (input) =>
      input.fromTurnCount <= input.toTurnCount ||
      new SchemaIssue.InvalidValue(Option.some(input.fromTurnCount), {
        message: "fromTurnCount must be less than or equal to toTurnCount",
      }),
    { identifier: "OrchestrationTurnDiffRange" },
  ),
);

export const ThreadTurnDiff = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    diff: Schema.String,
  }),
  { unsafePreserveChecks: true },
);

export const ProviderSessionRuntimeStatus = Schema.Literals([
  "starting",
  "running",
  "stopped",
  "error",
]);
export type ProviderSessionRuntimeStatus = typeof ProviderSessionRuntimeStatus.Type;

const ProjectionThreadTurnStatus = Schema.Literals([
  "running",
  "completed",
  "interrupted",
  "error",
]);
export type ProjectionThreadTurnStatus = typeof ProjectionThreadTurnStatus.Type;

const ProjectionCheckpointRow = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type ProjectionCheckpointRow = typeof ProjectionCheckpointRow.Type;

export const ProjectionPendingApprovalStatus = Schema.Literals(["pending", "resolved"]);
export type ProjectionPendingApprovalStatus = typeof ProjectionPendingApprovalStatus.Type;

export const ProjectionPendingApprovalDecision = Schema.NullOr(ProviderApprovalDecision);
export type ProjectionPendingApprovalDecision = typeof ProjectionPendingApprovalDecision.Type;

export const DispatchResult = Schema.Struct({
  sequence: NonNegativeInt,
});
export type DispatchResult = typeof DispatchResult.Type;

export const OrchestrationGetSnapshotInput = Schema.Struct({});
export type OrchestrationGetSnapshotInput = typeof OrchestrationGetSnapshotInput.Type;
const OrchestrationGetSnapshotResult = OrchestrationReadModel;
export type OrchestrationGetSnapshotResult = typeof OrchestrationGetSnapshotResult.Type;

export const OrchestrationGetTurnDiffInput = TurnCountRange.mapFields(
  Struct.assign({ threadId: ThreadId }),
  { unsafePreserveChecks: true },
);
export type OrchestrationGetTurnDiffInput = typeof OrchestrationGetTurnDiffInput.Type;

export const OrchestrationGetTurnDiffResult = ThreadTurnDiff;
export type OrchestrationGetTurnDiffResult = typeof OrchestrationGetTurnDiffResult.Type;

export const OrchestrationGetFullThreadDiffInput = Schema.Struct({
  threadId: ThreadId,
  toTurnCount: NonNegativeInt,
});
export type OrchestrationGetFullThreadDiffInput = typeof OrchestrationGetFullThreadDiffInput.Type;

export const OrchestrationGetFullThreadDiffResult = ThreadTurnDiff;
export type OrchestrationGetFullThreadDiffResult = typeof OrchestrationGetFullThreadDiffResult.Type;

export const OrchestrationGetMobileThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type OrchestrationGetMobileThreadInput = typeof OrchestrationGetMobileThreadInput.Type;

const OrchestrationGetMobileThreadResult = OrchestrationThread;
export type OrchestrationGetMobileThreadResult = typeof OrchestrationGetMobileThreadResult.Type;

export const OrchestrationReplayEventsInput = Schema.Struct({
  fromSequenceExclusive: NonNegativeInt,
});
export type OrchestrationReplayEventsInput = typeof OrchestrationReplayEventsInput.Type;

export const OrchestrationReplayAvailability = Schema.Literals(["available", "gap"]);
export type OrchestrationReplayAvailability = typeof OrchestrationReplayAvailability.Type;

const OrchestrationReplayEventsResult = Schema.Struct({
  requestedFromSequenceExclusive: NonNegativeInt,
  retainedFromSequenceExclusive: NonNegativeInt,
  earliestAvailableSequence: Schema.NullOr(NonNegativeInt),
  latestSequence: NonNegativeInt,
  availability: OrchestrationReplayAvailability,
  complete: Schema.Boolean,
  events: Schema.Array(OrchestrationEvent),
});
export type OrchestrationReplayEventsResult = typeof OrchestrationReplayEventsResult.Type;

export const OrchestrationRpcSchemas = {
  getSidebarThreadCatalog: {
    input: GetSidebarThreadCatalogInput,
    output: GetSidebarThreadCatalogResult,
  },
  getStartupProjectCatalog: {
    input: GetStartupProjectCatalogInput,
    output: GetStartupProjectCatalogResult,
  },
  getProjectThreadSummaries: {
    input: GetProjectThreadSummariesInput,
    output: GetProjectThreadSummariesResult,
  },
  getSelectedThreadDetail: {
    input: GetSelectedThreadDetailInput,
    output: GetSelectedThreadDetailResult,
  },
  getSnapshot: {
    input: OrchestrationGetSnapshotInput,
    output: OrchestrationGetSnapshotResult,
  },
  dispatchCommand: {
    input: ClientOrchestrationCommand,
    output: DispatchResult,
  },
  getTurnDiff: {
    input: OrchestrationGetTurnDiffInput,
    output: OrchestrationGetTurnDiffResult,
  },
  getFullThreadDiff: {
    input: OrchestrationGetFullThreadDiffInput,
    output: OrchestrationGetFullThreadDiffResult,
  },
  getMobileThread: {
    input: OrchestrationGetMobileThreadInput,
    output: OrchestrationGetMobileThreadResult,
  },
  replayEvents: {
    input: OrchestrationReplayEventsInput,
    output: OrchestrationReplayEventsResult,
  },
} as const;

export class OrchestrationGetStartupProjectCatalogError extends Schema.TaggedErrorClass<OrchestrationGetStartupProjectCatalogError>()(
  "OrchestrationGetStartupProjectCatalogError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class OrchestrationGetSidebarThreadCatalogError extends Schema.TaggedErrorClass<OrchestrationGetSidebarThreadCatalogError>()(
  "OrchestrationGetSidebarThreadCatalogError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class OrchestrationGetProjectThreadSummariesError extends Schema.TaggedErrorClass<OrchestrationGetProjectThreadSummariesError>()(
  "OrchestrationGetProjectThreadSummariesError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class OrchestrationGetSelectedThreadDetailError extends Schema.TaggedErrorClass<OrchestrationGetSelectedThreadDetailError>()(
  "OrchestrationGetSelectedThreadDetailError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class OrchestrationGetSnapshotError extends Schema.TaggedErrorClass<OrchestrationGetSnapshotError>()(
  "OrchestrationGetSnapshotError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class OrchestrationDispatchCommandError extends Schema.TaggedErrorClass<OrchestrationDispatchCommandError>()(
  "OrchestrationDispatchCommandError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class OrchestrationGetTurnDiffError extends Schema.TaggedErrorClass<OrchestrationGetTurnDiffError>()(
  "OrchestrationGetTurnDiffError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class OrchestrationGetFullThreadDiffError extends Schema.TaggedErrorClass<OrchestrationGetFullThreadDiffError>()(
  "OrchestrationGetFullThreadDiffError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class OrchestrationGetMobileThreadError extends Schema.TaggedErrorClass<OrchestrationGetMobileThreadError>()(
  "OrchestrationGetMobileThreadError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class OrchestrationReplayEventsError extends Schema.TaggedErrorClass<OrchestrationReplayEventsError>()(
  "OrchestrationReplayEventsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
