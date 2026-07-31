import type { OrchestrationTaskStatus } from "@bigbud/contracts";
import type { TaskFreshness } from "@bigbud/shared/providerRuntime";

export interface ClaudeTask {
  readonly id: string;
  readonly sourceToolUseId: string;
  readonly order: number;
  readonly subject: string;
  readonly turnId?: string | undefined;
  readonly description?: string | undefined;
  readonly status: OrchestrationTaskStatus;
  readonly nativeStatus?: string | undefined;
  readonly activeLabel?: string | undefined;
  readonly requestId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly parentAgentId?: string | undefined;
  readonly parentToolUseId?: string | undefined;
  readonly parentTaskId?: string | undefined;
  readonly subagentType?: string | undefined;
  readonly blocks?: ReadonlyArray<string> | undefined;
  readonly blockedBy?: ReadonlyArray<string> | undefined;
  readonly progressSummary?: string | undefined;
  readonly lastToolName?: string | undefined;
  readonly usage?: unknown | undefined;
  readonly terminalReason?: string | undefined;
  readonly taskListMember: boolean;
  readonly backgroundMember: boolean;
  readonly legacyMember: boolean;
  readonly observedMember: boolean;
  readonly lastObservedOrdinal: number;
  readonly membership?: {
    readonly taskList: boolean;
    readonly background: boolean;
    readonly observed: boolean;
    readonly legacy: boolean;
  };
  readonly freshness: TaskFreshness;
  readonly updatedAt: string;
}

export interface ClaudeTaskState {
  readonly tasks: Map<string, ClaudeTask>;
  readonly seenMessageIds: Set<string>;
  readonly seenInputFingerprints: Set<string>;
  readonly snapshotFingerprints: Map<string, string>;
  readonly snapshotFreshness: Map<string, TaskFreshness>;
  taskListGeneration: number;
  backgroundGeneration: number;
  /** Changes at adapter reinitialization; ordinal ordering never crosses this boundary. */
  sessionEpoch: string;
  nextOrder: number;
  nextObservedOrdinal: number;
}

export interface ClaudeTaskReduction {
  readonly changedTaskIds: ReadonlyArray<string>;
  readonly removedTaskIds: ReadonlyArray<string>;
  readonly changed: boolean;
}

export function makeClaudeTaskState(): ClaudeTaskState {
  return {
    tasks: new Map(),
    seenMessageIds: new Set(),
    seenInputFingerprints: new Set(),
    snapshotFingerprints: new Map(),
    snapshotFreshness: new Map(),
    taskListGeneration: 0,
    backgroundGeneration: 0,
    sessionEpoch: "initial",
    nextOrder: 0,
    nextObservedOrdinal: 0,
  };
}
