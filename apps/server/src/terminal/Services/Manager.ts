/**
 * TerminalManager - Terminal session orchestration service interface.
 *
 * Owns terminal lifecycle operations, output fanout, and session state
 * transitions for thread-scoped terminals.
 *
 * @module TerminalManager
 */
import type {
  TerminalSearchInput,
  TerminalSearchResult,
} from "@bigbud/contracts/workspace/terminal.search.ts";
import {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalDropPathMode,
  TerminalEvent,
  TerminalCwdError,
  TerminalError,
  TerminalHistoryError,
  TerminalRuntimeLeaseError,
  TerminalNotRunningError,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalSessionLookupError,
  TerminalSessionStatus,
  TerminalWriteInput,
} from "@bigbud/contracts";
import { PtyProcess } from "./PTY";
import { Effect, ServiceMap } from "effect";
import type {
  TerminalShellProfileInventory,
  TerminalShellProfilesInput,
} from "@bigbud/contracts/workspace/terminal.shellProfiles.ts";
import type { TerminalSnapshotInput } from "@bigbud/contracts/workspace/terminal.ts";
import type {
  TerminalRecoveryInput,
  TerminalRecoveryResult,
} from "@bigbud/contracts/workspace/terminal.recovery.ts";
import type { TerminalSessionInventory } from "@bigbud/contracts/workspace/terminal.stream.ts";

export {
  TerminalCwdError,
  TerminalError,
  TerminalHistoryError,
  TerminalRuntimeLeaseError,
  TerminalNotRunningError,
  TerminalSessionLookupError,
};

export interface TerminalSessionState {
  threadId: string;
  terminalId: string;
  executionTargetId: string;
  dropPathMode: TerminalDropPathMode;
  cwd: string;
  worktreePath: string | null;
  status: TerminalSessionStatus;
  pid: number | null;
  history: string;
  pendingHistoryControlSequence: string;
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

export interface ShellCandidate {
  shell: string;
  args?: string[];
  dropPathMode: TerminalDropPathMode;
}

export interface TerminalStartInput extends TerminalOpenInput {
  cols: number;
  rows: number;
}

export interface TerminalSubscribeOptions {
  /** `legacyDetection` keeps output only for sessions whose agent detection runs in the client. */
  readonly outputScope?: "all" | "legacyDetection";
  /** Delivered before replay, captured atomically with listener registration. */
  readonly onInventory?: (inventory: TerminalSessionInventory) => Effect.Effect<void>;
}

/**
 * TerminalManagerShape - Service API for terminal session lifecycle operations.
 */
export interface TerminalIdleWork {
  readonly state: "busy" | "unknown" | "idle";
  readonly quietSince: number | null;
}

export interface TerminalManagerShape {
  readonly listShellProfiles: (
    input: TerminalShellProfilesInput,
  ) => Effect.Effect<TerminalShellProfileInventory, TerminalError>;
  /** Server-owned sampled work facts; a shell alone is not work. */
  readonly getThreadIdleWork?: (threadId: string) => Effect.Effect<TerminalIdleWork>;
  /** Cached owner facts only; no OS/global process rescan. */
  readonly snapshotThreadIdleWork?: () => Effect.Effect<ReadonlyMap<string, TerminalIdleWork>>;
  readonly forgetThreadIdleWork?: (threadId: string) => Effect.Effect<void>;
  readonly recovery?: (
    input: TerminalRecoveryInput,
  ) => Effect.Effect<TerminalRecoveryResult, TerminalError>;
  readonly hasActiveThread?: (threadId: string) => Effect.Effect<boolean>;
  /** Terminal sessions currently tracked for one execution target, for targeted shutdown. */
  readonly listExecutionTargetSessions?: (
    executionTargetId: string,
  ) => Effect.Effect<ReadonlyArray<{ readonly threadId: string; readonly terminalId: string }>>;
  /**
   * Open or attach to a terminal session.
   *
   * Reuses an existing session for the same thread/terminal id and restores
   * persisted history on first open.
   */
  readonly open: (
    input: TerminalOpenInput,
  ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

  /** Read retained history without creating, restarting, or resizing a PTY. */
  readonly snapshot: (
    input: TerminalSnapshotInput,
  ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

  /**
   * Write input bytes to a terminal session.
   */
  readonly write: (input: TerminalWriteInput) => Effect.Effect<void, TerminalError>;

  /**
   * Resize the PTY backing a terminal session.
   */
  readonly resize: (input: TerminalResizeInput) => Effect.Effect<void, TerminalError>;

  /**
   * Clear terminal output history.
   */
  readonly clear: (input: TerminalClearInput) => Effect.Effect<void, TerminalError>;

  /**
   * Restart a terminal session in place.
   *
   * Always resets history before spawning the new process.
   */
  readonly restart: (
    input: TerminalRestartInput,
  ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

  /**
   * Close an active terminal session.
   *
   * When `terminalId` is omitted, closes all sessions for the thread.
   */
  readonly close: (input: TerminalCloseInput) => Effect.Effect<void, TerminalError>;

  /**
   * Subscribe to terminal runtime events with a direct callback.
   *
   * Returns an unsubscribe function.
   */
  readonly subscribe: (
    listener: (event: TerminalEvent) => Effect.Effect<void>,
    options?: TerminalSubscribeOptions,
  ) => Effect.Effect<() => void>;

  /**
   * Hold or release a terminal's PTY output for one delivery subscriber (producer flow control).
   * Succeeds with whether the running process supports pausing; unsupported adapters are bounded
   * by delivery overflow instead.
   */
  /** Search the output terminals retain (newest lines first); scan on demand, no index. */
  readonly search?: (input: TerminalSearchInput) => Effect.Effect<TerminalSearchResult>;

  readonly setOutputHold?: (input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly holderId: string;
    readonly held: boolean;
  }) => Effect.Effect<boolean>;
}

/**
 * TerminalManager - Service tag for terminal session orchestration.
 */
export class TerminalManager extends ServiceMap.Service<TerminalManager, TerminalManagerShape>()(
  "t3/terminal/Services/Manager/TerminalManager",
) {}
