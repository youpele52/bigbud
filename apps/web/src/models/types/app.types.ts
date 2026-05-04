import type {
  ModelSelection,
  OrchestrationLatestTurn,
  OrchestrationProposedPlanId,
  OrchestrationSessionStatus,
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

export type ChatAttachment = ChatImageAttachment | ChatFileAttachment;

export interface ChatMessage {
  id: MessageId;
  role: "user" | "assistant" | "system";
  text: string;
  attachments?: ChatAttachment[];
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
  cwd: string | null;
  defaultModelSelection: ModelSelection | null;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  scripts: ProjectScript[];
}

export interface Thread {
  id: ThreadId;
  codexThreadId: string | null;
  projectId: ProjectId;
  parentThread?: {
    threadId: ThreadId;
    title: string;
  };
  title: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  session: ThreadSession | null;
  messages: ChatMessage[];
  proposedPlans: ProposedPlan[];
  error: string | null;
  createdAt: string;
  archivedAt: string | null;
  updatedAt?: string | undefined;
  latestTurn: OrchestrationLatestTurn | null;
  pendingSourceProposedPlan?: OrchestrationLatestTurn["sourceProposedPlan"];
  branch: string | null;
  worktreePath: string | null;
  turnDiffSummaries: TurnDiffSummary[];
  activities: OrchestrationThreadActivity[];
}

export interface SidebarThreadSummary {
  id: ThreadId;
  projectId: ProjectId;
  parentThread?: {
    threadId: ThreadId;
    title: string;
  };
  title: string;
  interactionMode: ProviderInteractionMode;
  session: ThreadSession | null;
  createdAt: string;
  archivedAt: string | null;
  updatedAt?: string | undefined;
  latestTurn: OrchestrationLatestTurn | null;
  branch: string | null;
  worktreePath: string | null;
  latestUserMessageAt: string | null;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
  hasActionableProposedPlan: boolean;
}

export interface ThreadSession {
  provider: ProviderKind;
  status: SessionPhase | "error" | "closed";
  activeTurnId?: TurnId | undefined;
  createdAt: string;
  updatedAt: string;
  reason?: string | null;
  lastError?: string;
  orchestrationStatus: OrchestrationSessionStatus;
}
