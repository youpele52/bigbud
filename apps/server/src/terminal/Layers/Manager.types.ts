import type * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";

import type {
  TerminalCwdError,
  TerminalRuntimeLeaseError,
  TerminalDropPathMode,
  TerminalSessionStatus,
} from "@bigbud/contracts";
import type { ProviderKind } from "@bigbud/contracts/orchestration/orchestration.provider";
import type { PtyAdapterShape, PtyExitEvent, PtyProcess } from "../Services/PTY";
import type { TerminalSubprocessChecker } from "./Manager.shell";
import type { TerminalAgentDetector } from "./Manager.agentDetection";
import type { TerminalWslIdentity } from "@bigbud/contracts/workspace/terminal.wsl.ts";
import type { TerminalAgentIdentity } from "@bigbud/contracts/workspace/terminal.agentIdentity.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_HISTORY_LINE_LIMIT = 5_000;
export const DEFAULT_PERSIST_DEBOUNCE_MS = 250;
export const DEFAULT_SUBPROCESS_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_PROCESS_KILL_GRACE_MS = 1_000;
export const DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS = 128;
export const DEFAULT_OPEN_COLS = 120;
export const DEFAULT_OPEN_ROWS = 30;

// ---------------------------------------------------------------------------
// Session / state shapes
// ---------------------------------------------------------------------------

export interface TerminalSessionState {
  wslIdentity?: TerminalWslIdentity | undefined;
  remoteOwnerRecoveryRequired?: boolean;
  restartPending?: boolean;
  restartPreparation?: (() => Promise<void>) | undefined;
  threadId: string;
  terminalId: string;
  executionTargetId: string;
  dropPathMode: TerminalDropPathMode;
  cwd: string;
  worktreePath: string | null;
  directoryFallback?: { requestedCwd: string; reason: string } | undefined;
  runtimeEpoch: number;
  runtimeGeneration: string;
  status: TerminalSessionStatus;
  pid: number | null;
  history: string;
  historyTruncated?: boolean;
  historyUnavailable?: boolean;
  historyBytes?: number;
  historyNewlines?: number;
  historyTail?: string;
  pendingHistoryBytes?: number;
  pendingHistoryControlSequence: string;
  pendingProcessEvents: Array<PendingProcessEvent>;
  pendingProcessEventIndex: number;
  processEventDrainRunning: boolean;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
  cols: number;
  rows: number;
  process: PtyProcess | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
  hasRunningSubprocess: boolean;
  activeAgentProvider: ProviderKind | null;
  activeAgent?: TerminalAgentIdentity | null;
  agentIdentityMisses: number;
  runtimeEnv: Record<string, string> | null;
}

export interface PersistHistoryRequest {
  history: string;
  immediate: boolean;
}

export type PendingProcessEvent =
  | { type: "output"; data: string }
  | { type: "exit"; event: PtyExitEvent };

export type DrainProcessEventAction =
  | { type: "idle" }
  | {
      type: "output";
      threadId: string;
      terminalId: string;
      history: string | null;
      data: string;
    }
  | {
      type: "exit";
      process: PtyProcess | null;
      threadId: string;
      terminalId: string;
      exitCode: number | null;
      exitSignal: number | null;
    };

export interface TerminalManagerState {
  sessions: Map<string, TerminalSessionState>;
  killFibers: Map<PtyProcess, Fiber.Fiber<void, never>>;
}

export interface TerminalStartInput {
  threadId: string;
  terminalId: string;
  executionTargetId?: string;
  cwd: string;
  worktreePath?: string | null;
  cols: number;
  rows: number;
  env?: Record<string, string>;
}

export interface TerminalManagerOptions {
  resolveRuntimePathIdentity?: (
    cwd: string,
  ) => Effect.Effect<RuntimePathIdentity, TerminalCwdError>;
  logsDir: string;
  historyLineLimit?: number;
  ptyAdapter: PtyAdapterShape;
  shellResolver?: () => string;
  subprocessChecker?: TerminalSubprocessChecker;
  agentDetector?: TerminalAgentDetector;
  subprocessPollIntervalMs?: number;
  processKillGraceMs?: number;
  maxRetainedInactiveSessions?: number;
  acquireWorktreeLease?: (input: {
    runtimePathIdentity?: RuntimePathIdentity | undefined;
    threadId: string;
    terminalId: string;
    executionTargetId: string;
    cwd: string;
    worktreePath: string | null;
  }) => Effect.Effect<void, TerminalCwdError | TerminalRuntimeLeaseError>;
  markWorktreeLeaseStarted?: (input: {
    threadId: string;
    terminalId: string;
    processId: number;
  }) => Effect.Effect<void>;
  releaseWorktreeLease?: (input: { threadId: string; terminalId: string }) => Effect.Effect<void>;
}

export interface RuntimePathIdentity {
  readonly canonicalPath: string;
  readonly device: number;
  readonly inode: number;
}
