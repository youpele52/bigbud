import type { Fiber } from "effect";

import type { TerminalSessionStatus } from "@bigbud/contracts";
import type { PtyAdapterShape, PtyExitEvent, PtyProcess } from "../Services/PTY";
import type { TerminalSubprocessChecker } from "./Manager.shell";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_HISTORY_LINE_LIMIT = 5_000;
export const DEFAULT_PERSIST_DEBOUNCE_MS = 40;
export const DEFAULT_SUBPROCESS_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_PROCESS_KILL_GRACE_MS = 1_000;
export const DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS = 128;
export const DEFAULT_OPEN_COLS = 120;
export const DEFAULT_OPEN_ROWS = 30;

// ---------------------------------------------------------------------------
// Session / state shapes
// ---------------------------------------------------------------------------

export interface TerminalSessionState {
  threadId: string;
  terminalId: string;
  cwd: string;
  worktreePath: string | null;
  status: TerminalSessionStatus;
  pid: number | null;
  history: string;
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
  cwd: string;
  worktreePath?: string | null;
  cols: number;
  rows: number;
  env?: Record<string, string>;
}

export interface TerminalManagerOptions {
  logsDir: string;
  historyLineLimit?: number;
  ptyAdapter: PtyAdapterShape;
  shellResolver?: () => string;
  subprocessChecker?: TerminalSubprocessChecker;
  subprocessPollIntervalMs?: number;
  processKillGraceMs?: number;
  maxRetainedInactiveSessions?: number;
}
