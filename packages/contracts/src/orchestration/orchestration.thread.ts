import { Schema } from "effect";
import {
  CheckpointRef,
  CommandId,
  ExecutionTargetId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  RuntimeTaskId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "../core/baseSchemas";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ProviderInteractionMode,
  RuntimeMode,
} from "./orchestration.provider";
import { ChatAttachment } from "./orchestration.attachments";
import { ModelSelection } from "./orchestration.provider";
import { OrchestrationProject } from "./orchestration.project";

export const ELEVATOR_SUMMARY_MAX_CHARS = 150;
export const ElevatorSummary = TrimmedNonEmptyString.check(
  Schema.isMaxLength(ELEVATOR_SUMMARY_MAX_CHARS),
);
export type ElevatorSummary = typeof ElevatorSummary.Type;

export const OrchestrationMessageRole = Schema.Literals(["user", "assistant", "system"]);
export type OrchestrationMessageRole = typeof OrchestrationMessageRole.Type;

export const OrchestrationThreadPurpose = Schema.Literals(["standard", "side-chat"]);
export type OrchestrationThreadPurpose = typeof OrchestrationThreadPurpose.Type;

export const OrchestrationMessageReply = Schema.Struct({
  messageId: MessageId,
  role: OrchestrationMessageRole,
  createdAt: IsoDateTime,
  excerpt: Schema.String,
});
export type OrchestrationMessageReply = typeof OrchestrationMessageReply.Type;

export const OrchestrationMessage = Schema.Struct({
  id: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  replyTo: Schema.optional(OrchestrationMessageReply),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationMessage = typeof OrchestrationMessage.Type;

export const OrchestrationProposedPlanId = TrimmedNonEmptyString;
export type OrchestrationProposedPlanId = typeof OrchestrationProposedPlanId.Type;

export const OrchestrationProposedPlan = Schema.Struct({
  id: OrchestrationProposedPlanId,
  turnId: Schema.NullOr(TurnId),
  planMarkdown: TrimmedNonEmptyString,
  implementedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(() => null)),
  implementationThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(() => null)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProposedPlan = typeof OrchestrationProposedPlan.Type;

export const SourceProposedPlanReference = Schema.Struct({
  threadId: ThreadId,
  planId: OrchestrationProposedPlanId,
});
export type SourceProposedPlanReference = typeof SourceProposedPlanReference.Type;

export const ParentThreadReference = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  // Optional while decoding legacy local projections; new references include it.
  projectId: Schema.optional(ProjectId),
});
export type ParentThreadReference = typeof ParentThreadReference.Type;

export const WatchingThreadReference = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
});
export type WatchingThreadReference = typeof WatchingThreadReference.Type;

export const OrchestrationSessionStatus = Schema.Literals([
  "idle",
  "starting",
  "running",
  "ready",
  "interrupted",
  "stopped",
  "error",
]);
export type OrchestrationSessionStatus = typeof OrchestrationSessionStatus.Type;

export const OrchestrationSession = Schema.Struct({
  threadId: ThreadId,
  status: OrchestrationSessionStatus,
  providerName: Schema.NullOr(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  activeTurnId: Schema.NullOr(TurnId),
  /** bigbud-owned provider-session incarnation fence. Legacy sessions decode as epoch zero. */
  sessionEpoch: Schema.optional(NonNegativeInt),
  reason: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});
export type OrchestrationSession = typeof OrchestrationSession.Type;

export const OrchestrationCheckpointFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type OrchestrationCheckpointFile = typeof OrchestrationCheckpointFile.Type;

export const OrchestrationCheckpointStatus = Schema.Literals(["ready", "missing", "error"]);
export type OrchestrationCheckpointStatus = typeof OrchestrationCheckpointStatus.Type;

export const OrchestrationCheckpointSummary = Schema.Struct({
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type OrchestrationCheckpointSummary = typeof OrchestrationCheckpointSummary.Type;

export const OrchestrationThreadActivityTone = Schema.Literals([
  "info",
  "thinking",
  "tool",
  "approval",
  "error",
]);
export type OrchestrationThreadActivityTone = typeof OrchestrationThreadActivityTone.Type;

export const OrchestrationThreadActivity = Schema.Struct({
  id: EventId,
  tone: OrchestrationThreadActivityTone,
  kind: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  payload: Schema.Unknown,
  turnId: Schema.NullOr(TurnId),
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});
export type OrchestrationThreadActivity = typeof OrchestrationThreadActivity.Type;

export const OrchestrationTaskStatus = Schema.Literals([
  "pending",
  "inProgress",
  "completed",
  "failed",
  "stopped",
]);
export type OrchestrationTaskStatus = typeof OrchestrationTaskStatus.Type;

/** The source whose observed membership currently keeps a modern task visible. */
export const OrchestrationTaskSource = Schema.Literals([
  "lifecycle",
  "taskList",
  "background",
  "observed",
]);
export type OrchestrationTaskSource = typeof OrchestrationTaskSource.Type;

/** Additive ordering data; legacy snapshots decode into the deterministic legacy epoch. */
export const OrchestrationTaskFreshness = Schema.Struct({
  sessionEpoch: Schema.String.pipe(Schema.withDecodingDefault(() => "legacy")),
  sourcePriority: NonNegativeInt.pipe(Schema.withDecodingDefault(() => 0)),
  snapshotGeneration: Schema.optional(NonNegativeInt),
  providerRevision: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  providerMessageId: Schema.optional(TrimmedNonEmptyString),
  providerTimestamp: Schema.optional(IsoDateTime),
  observedOrdinal: NonNegativeInt.pipe(Schema.withDecodingDefault(() => 0)),
});
export type OrchestrationTaskFreshness = typeof OrchestrationTaskFreshness.Type;

/** Provider-neutral durable task state, including optional subagent relationships. */
export const OrchestrationTaskMembership = Schema.Struct({
  taskList: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  background: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  observed: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  legacy: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
});
export type OrchestrationTaskMembership = typeof OrchestrationTaskMembership.Type;

export const OrchestrationTask = Schema.Struct({
  id: RuntimeTaskId,
  status: OrchestrationTaskStatus,
  subject: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  activeLabel: Schema.optional(TrimmedNonEmptyString),
  sourceToolUseId: Schema.optional(TrimmedNonEmptyString),
  requestId: Schema.optional(TrimmedNonEmptyString),
  agentId: Schema.optional(TrimmedNonEmptyString),
  parentAgentId: Schema.optional(TrimmedNonEmptyString),
  parentToolUseId: Schema.optional(TrimmedNonEmptyString),
  parentTaskId: Schema.optional(RuntimeTaskId),
  subagentType: Schema.optional(TrimmedNonEmptyString),
  background: Schema.optional(Schema.Boolean),
  blockedBy: Schema.optional(Schema.Array(RuntimeTaskId)),
  progressSummary: Schema.optional(TrimmedNonEmptyString),
  lastToolName: Schema.optional(TrimmedNonEmptyString),
  usage: Schema.optional(Schema.Unknown),
  terminalReason: Schema.optional(TrimmedNonEmptyString),
  turnId: Schema.optional(TurnId),
  order: Schema.optional(NonNegativeInt),
  membership: Schema.optional(OrchestrationTaskMembership),
  source: OrchestrationTaskSource.pipe(Schema.withDecodingDefault(() => "lifecycle")),
  freshness: OrchestrationTaskFreshness.pipe(
    Schema.withDecodingDefault(() => ({
      sessionEpoch: "legacy",
      sourcePriority: 0,
      observedOrdinal: 0,
    })),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationTask = typeof OrchestrationTask.Type;

export const OrchestrationLatestTurnState = Schema.Literals([
  "running",
  "interrupted",
  "completed",
  "error",
]);
export type OrchestrationLatestTurnState = typeof OrchestrationLatestTurnState.Type;

export const OrchestrationLatestTurn = Schema.Struct({
  turnId: TurnId,
  state: OrchestrationLatestTurnState,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
});
export type OrchestrationLatestTurn = typeof OrchestrationLatestTurn.Type;

export const OrchestrationQueuedPrompt = Schema.Struct({
  id: MessageId,
  text: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type OrchestrationQueuedPrompt = typeof OrchestrationQueuedPrompt.Type;

export const OrchestrationTurnControlAction = Schema.Literals([
  "steer",
  "interrupt-and-continue",
  "stop",
]);
export type OrchestrationTurnControlAction = typeof OrchestrationTurnControlAction.Type;

export const OrchestrationTurnControlStrategy = Schema.Literals([
  "pending-selection",
  "native-steer",
  "interrupt-continue",
  "stop-session",
]);
export type OrchestrationTurnControlStrategy = typeof OrchestrationTurnControlStrategy.Type;

export const OrchestrationTurnControlState = Schema.Literals([
  "requested",
  "provider-acknowledged",
  "waiting-for-settlement",
  "completed",
  "failed",
  "ambiguous",
  "superseded",
  "cancelled",
]);
export type OrchestrationTurnControlState = typeof OrchestrationTurnControlState.Type;

/** Durable provider-neutral operation and exact queue-prefix reservation. */
export const OrchestrationTurnControlOperation = Schema.Struct({
  operationId: CommandId,
  action: OrchestrationTurnControlAction,
  reservedPromptIds: Schema.Array(MessageId),
  sessionEpoch: NonNegativeInt,
  expectedTurnId: Schema.NullOr(TurnId),
  strategy: OrchestrationTurnControlStrategy,
  state: OrchestrationTurnControlState,
  requestedAt: IsoDateTime,
  updatedAt: IsoDateTime,
  acknowledgedAt: Schema.optional(IsoDateTime),
  settledAt: Schema.optional(IsoDateTime),
  error: Schema.optional(TrimmedNonEmptyString),
  deliveryAmbiguous: Schema.optional(Schema.Boolean),
});
export type OrchestrationTurnControlOperation = typeof OrchestrationTurnControlOperation.Type;

/** Durable Send now request; its captured prefix must be consumed exactly once. */
export const OrchestrationPendingInterruptFlushIntent = Schema.Struct({
  intentId: CommandId,
  requestedTurnId: Schema.optional(Schema.NullOr(TurnId)),
  queuedPromptIds: Schema.Array(MessageId),
  requestedAt: IsoDateTime,
});
export type OrchestrationPendingInterruptFlushIntent =
  typeof OrchestrationPendingInterruptFlushIntent.Type;

export const OrchestrationThread = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  purpose: Schema.optional(OrchestrationThreadPurpose),
  elevatorSummary: Schema.NullOr(ElevatorSummary).pipe(Schema.withDecodingDefault(() => null)),
  elevatorSummaryMessageCount: NonNegativeInt.pipe(Schema.withDecodingDefault(() => 0)),
  providerRuntimeExecutionTargetId: Schema.optional(ExecutionTargetId),
  workspaceExecutionTargetId: Schema.optional(ExecutionTargetId),
  executionTargetId: Schema.optional(ExecutionTargetId),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  queuedPrompts: Schema.optional(Schema.Array(OrchestrationQueuedPrompt)).pipe(
    Schema.withDecodingDefault(() => []),
  ),
  pendingInterruptFlushIntent: Schema.optional(
    Schema.NullOr(OrchestrationPendingInterruptFlushIntent),
  ).pipe(Schema.withDecodingDefault(() => null)),
  pendingTurnControlOperation: Schema.optional(
    Schema.NullOr(OrchestrationTurnControlOperation),
  ).pipe(Schema.withDecodingDefault(() => null)),
  queueHold: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(() => null)),
  pinnedAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  deletingAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  deletedAt: Schema.NullOr(IsoDateTime),
  parentThread: Schema.optional(ParentThreadReference),
  messages: Schema.Array(OrchestrationMessage),
  proposedPlans: Schema.Array(OrchestrationProposedPlan).pipe(Schema.withDecodingDefault(() => [])),
  // Optional for snapshots created before durable task projection was introduced.
  tasks: Schema.optional(Schema.Array(OrchestrationTask)).pipe(
    Schema.withDecodingDefault(() => []),
  ),
  activities: Schema.Array(OrchestrationThreadActivity),
  checkpoints: Schema.Array(OrchestrationCheckpointSummary),
  session: Schema.NullOr(OrchestrationSession),
  watchingThreads: Schema.Array(WatchingThreadReference).pipe(Schema.withDecodingDefault(() => [])),
});
export type OrchestrationThread = typeof OrchestrationThread.Type;

export const OrchestrationReadModel = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProject),
  threads: Schema.Array(OrchestrationThread),
  updatedAt: IsoDateTime,
});
export type OrchestrationReadModel = typeof OrchestrationReadModel.Type;
