import type {
  ExecutionTargetId,
  ModelSelection,
  OrchestrationLatestTurn,
  OrchestrationQueuedPrompt,
  OrchestrationProposedPlanId,
  OrchestrationSessionStatus,
  OrchestrationTurnControlOperation,
  OrchestrationThreadPurpose,
  OrchestrationThreadActivity,
  ProjectScript as ContractProjectScript,
  ThreadId,
  ProjectId,
  TurnId,
  MessageId,
  ProviderKind,
  CheckpointRef,
  ProviderInteractionMode,
  RuntimeMode,
} from "@bigbud/contracts";
import type { ThreadDetailDelegatedChild } from "@bigbud/contracts/orchestration/orchestration.detail.ts";
import type { DelegationModelChoiceLinkedSummary } from "@bigbud/contracts/orchestration/orchestration.delegationModelChoice";
import type { DelegatedModelChoiceRecord } from "@bigbud/shared/delegatedModelChoice";
import type { MessageOriginSegment } from "@bigbud/contracts/orchestration/orchestration.messageOrigin.ts";
import type { ThreadForkOrigin } from "@bigbud/contracts/orchestration/orchestration.fork.ts";
import type {
  ThreadRecovery,
  ThreadRecoveryStatus,
} from "@bigbud/contracts/orchestration/orchestration.recovery.ts";
import type { OrchestrationTask } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import {
  DEFAULT_RUNTIME_MODE as _DEFAULT_RUNTIME_MODE,
  DEFAULT_PROVIDER_INTERACTION_MODE as _DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_TERMINAL_ID as _DEFAULT_TERMINAL_ID,
  DEFAULT_THREAD_TERMINAL_HEIGHT as _DEFAULT_THREAD_TERMINAL_HEIGHT,
  MAX_TERMINALS_PER_GROUP as _MAX_TERMINALS_PER_GROUP,
} from "@bigbud/contracts";

export type SessionPhase = "disconnected" | "connecting" | "ready" | "running";

/** @deprecated Import `DEFAULT_RUNTIME_MODE` from `@bigbud/contracts` directly. */
export const DEFAULT_RUNTIME_MODE: RuntimeMode = _DEFAULT_RUNTIME_MODE;
/** @deprecated Import `DEFAULT_PROVIDER_INTERACTION_MODE` from `@bigbud/contracts` directly. */
export const DEFAULT_INTERACTION_MODE: ProviderInteractionMode = _DEFAULT_PROVIDER_INTERACTION_MODE;
/** @deprecated Import `DEFAULT_THREAD_TERMINAL_HEIGHT` from `@bigbud/contracts` directly. */
export const DEFAULT_THREAD_TERMINAL_HEIGHT = _DEFAULT_THREAD_TERMINAL_HEIGHT;
/** @deprecated Import `DEFAULT_TERMINAL_ID` from `@bigbud/contracts` directly. */
export const DEFAULT_THREAD_TERMINAL_ID = _DEFAULT_TERMINAL_ID;
/** @deprecated Import `MAX_TERMINALS_PER_GROUP` from `@bigbud/contracts` directly. */
export const MAX_TERMINALS_PER_GROUP = _MAX_TERMINALS_PER_GROUP;
export type ProjectScript = ContractProjectScript;

export interface ThreadTerminalGroup {
  id: string;
  terminalIds: string[];
}

export interface ChatImageAttachment {
  type: "image";
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl?: string;
}

export interface ChatFileAttachment {
  type: "file";
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** Original file path (desktop) or server-side copy path (web/base64). */
  sourcePath?: string;
}

export interface ChatPathAttachment {
  type: "path";
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: 0;
  path: string;
  entryKind: "file" | "directory";
}

export interface ChatThreadAttachment {
  type: "thread";
  id: string;
  name: string;
  mimeType: "application/x-bigbud-thread-reference";
  sizeBytes: 0;
  threadId: ThreadId;
  title: string;
  watchForCompletion?: boolean;
}

export type ChatAttachment =
  | ChatImageAttachment
  | ChatFileAttachment
  | ChatPathAttachment
  | ChatThreadAttachment;

export interface ChatMessageReplyTarget {
  messageId: MessageId;
  role: "user" | "assistant" | "system";
  createdAt: string;
  excerpt: string;
}

export interface ChatMessage {
  id: MessageId;
  role: "user" | "assistant" | "system";
  text: string;
  attachments?: ChatAttachment[];
  replyTo?: ChatMessageReplyTarget;
  originSegments?: ReadonlyArray<MessageOriginSegment>;
  turnId?: TurnId | null;
  createdAt: string;
  completedAt?: string | undefined;
  streaming: boolean;
}

export interface ProposedPlan {
  id: OrchestrationProposedPlanId;
  turnId: TurnId | null;
  planMarkdown: string;
  implementedAt: string | null;
  implementationThreadId: ThreadId | null;
  createdAt: string;
  updatedAt: string;
}

export interface TurnDiffFileChange {
  path: string;
  kind?: string | undefined;
  additions?: number | undefined;
  deletions?: number | undefined;
}

export interface TurnDiffSummary {
  turnId: TurnId;
  completedAt: string;
  status?: string | undefined;
  files: TurnDiffFileChange[];
  checkpointRef?: CheckpointRef | undefined;
  assistantMessageId?: MessageId | undefined;
  checkpointTurnCount?: number | undefined;
}

export interface Project {
  id: ProjectId;
  name: string;
  activeThreadCount?: number;
  providerRuntimeExecutionTargetId?: ExecutionTargetId;
  workspaceExecutionTargetId?: ExecutionTargetId;
  executionTargetId?: ExecutionTargetId;
  cwd: string | null;
  defaultModelSelection: ModelSelection | null;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  deletingAt?: string | null;
  scripts: ProjectScript[];
}

/** Client view of the latest turn-start request; drives the reconnecting notice. */
/** A `provider.session.recovery` step the server reported while this request was current. */
export interface ThreadTurnStartRecoveryStep {
  readonly step: string;
  readonly outcome: string;
}

export interface ThreadTurnStartRequest {
  messageId: MessageId;
  requestedAt: string;
  outcome: "pending" | "started" | "failed";
  settledAt: string | null;
  /** Attached by arrival order, never by comparing the server's and the request's clocks. */
  recoverySteps: ReadonlyArray<ThreadTurnStartRecoveryStep>;
}

/**
 * A delegated child's model choice as the trunk sees it: the full record mirrored from a loaded
 * tributary, else the summary on the trunk's own `delegation.child-linked` activity.
 */
export type DelegatedChildModelChoice =
  | { readonly source: "tributary"; readonly record: DelegatedModelChoiceRecord }
  | { readonly source: "linked"; readonly summary: DelegationModelChoiceLinkedSummary };

/** The server's delegated-child summary plus the web-only model choice mirror (never sent). */
export type DelegatedChildSummary = ThreadDetailDelegatedChild & {
  readonly modelChoice?: DelegatedChildModelChoice;
};

export interface Thread {
  worktreeBinding?:
    | import("@bigbud/contracts/workspace/worktreeBinding.ts").WorktreeBinding
    | undefined;
  id: ThreadId;
  codexThreadId: string | null;
  projectId: ProjectId;
  providerRuntimeExecutionTargetId?: ExecutionTargetId;
  workspaceExecutionTargetId?: ExecutionTargetId;
  executionTargetId?: ExecutionTargetId;
  parentThread?: {
    threadId: ThreadId;
    title: string;
  };
  /** Present only on server-side forks. */
  forkOrigin?: ThreadForkOrigin;
  title: string;
  purpose?: OrchestrationThreadPurpose;
  elevatorSummary?: string | null;
  elevatorSummaryMessageCount?: number;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  session: ThreadSession | null;
  messages: ChatMessage[];
  proposedPlans: ProposedPlan[];
  providerAgents?: OrchestrationTask[];
  delegatedChildren?: DelegatedChildSummary[];
  queuedPrompts?: Array<OrchestrationQueuedPrompt>;
  pendingTurnControlOperation?: OrchestrationTurnControlOperation | null;
  queueHold?: boolean;
  error: string | null;
  createdAt: string;
  archivedAt: string | null;
  pinnedAt?: string | null;
  deletingAt?: string | null;
  updatedAt?: string | undefined;
  latestTurn: OrchestrationLatestTurn | null;
  turnStartRequest?: ThreadTurnStartRequest | null | undefined;
  /** Sleep and wake recovery state from the server projection. */
  recovery?: ThreadRecovery | null;
  pendingSourceProposedPlan?: OrchestrationLatestTurn["sourceProposedPlan"];
  branch: string | null;
  worktreePath: string | null;
  turnDiffSummaries: TurnDiffSummary[];
  activities: OrchestrationThreadActivity[];
  watchingThreads?: Array<{
    threadId: ThreadId;
    title: string;
  }>;
}

export interface SidebarThreadSummary {
  id: ThreadId;
  projectId: ProjectId;
  providerRuntimeExecutionTargetId?: ExecutionTargetId;
  workspaceExecutionTargetId?: ExecutionTargetId;
  executionTargetId?: ExecutionTargetId;
  parentThread?: {
    threadId: ThreadId;
    title: string;
  };
  title: string;
  elevatorSummary?: string | null;
  elevatorSummaryMessageCount?: number;
  interactionMode: ProviderInteractionMode;
  session: ThreadSession | null;
  createdAt: string;
  archivedAt: string | null;
  pinnedAt: string | null;
  deletingAt?: string | null;
  updatedAt?: string | undefined;
  latestTurn: OrchestrationLatestTurn | null;
  branch: string | null;
  worktreePath: string | null;
  latestUserMessageAt: string | null;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
  hasActionableProposedPlan: boolean;
  providerAgents?: OrchestrationTask[];
  /** `continuing` keeps the pill on Working while bigbud resumes a turn after sleep. */
  recoveryStatus?: ThreadRecoveryStatus | null;
}

export type ThreadSessionProvider = ProviderKind | "unknown";

export interface ThreadSession {
  retainedFamily?: boolean | undefined;
  provider: ThreadSessionProvider;
  status: SessionPhase | "error" | "closed";
  activeTurnId?: TurnId | undefined;
  sessionEpoch?: number | undefined;
  createdAt: string;
  updatedAt: string;
  reason?: string | null;
  lastError?: string;
  orchestrationStatus: OrchestrationSessionStatus;
}
