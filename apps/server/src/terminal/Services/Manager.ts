import type {
  TerminalRemoteInventoryInput,
  TerminalRemoteInventory,
  TerminalRemoteAttachInput,
  TerminalRemoteDetachInput,
} from "@bigbud/contracts/workspace/terminal.remote.ts";
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
  TerminalForgetRetainedShellOwnersResult,
  TerminalRetainedShellOwners,
  TerminalRetainedShellOwnersInput,
} from "@bigbud/contracts/workspace/terminal.shellOwners.ts";
import type {
  TerminalRecoveryInput,
  TerminalRecoveryResult,
} from "@bigbud/contracts/workspace/terminal.recovery.ts";
import type {
  TerminalScreenItem,
  TerminalSessionInventory,
} from "@bigbud/contracts/workspace/terminal.stream.ts";
import type {
  TerminalCloseDrainingHostsResult,
  TerminalKeepOpenInput,
  TerminalLifecycleNotice,
} from "@bigbud/contracts/workspace/terminal.lifecycle.ts";
import type {
  TerminalPasteStageError,
  TerminalPasteStageInput,
  TerminalPasteStageResult,
} from "@bigbud/contracts/workspace/terminal.paste.ts";

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

/** Receives one session stream's items; `screen` comes first when the subscriber accepts it. */
export interface TerminalSessionStreamSink {
  readonly screen: (item: TerminalScreenItem) => void;
  readonly event: (event: TerminalEvent) => void;
  /** The subscriber fell too far behind while its screen was fetched; end its stream. */
  readonly overflow: () => void;
}

export interface TerminalSessionStreamHandle {
  /** Call after the `subscribed` item: the screen (if any) and then live events follow. */
  readonly start: () => void;
  /** `acknowledgedChars`: output the view parsed, for the host's query cut on detach (§8.9). */
  readonly unsubscribe: (acknowledgedChars: number) => void;
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
  readonly remoteInventory?: (
    input: TerminalRemoteInventoryInput,
  ) => Effect.Effect<TerminalRemoteInventory, TerminalError>;
  readonly remoteAttach?: (
    input: TerminalRemoteAttachInput,
  ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;
  readonly remoteDetach?: (input: TerminalRemoteDetachInput) => Effect.Effect<void, TerminalError>;
  readonly remoteStop?: (input: TerminalRemoteAttachInput) => Effect.Effect<void, TerminalError>;
  /** Unverifiable direct-shell records that block this thread's deletion. */
  readonly retainedShellOwners?: (
    input: TerminalRetainedShellOwnersInput,
  ) => Effect.Effect<TerminalRetainedShellOwners, TerminalError>;
  /** Explicit user recovery: forgets only this thread's records; remote shells keep running. */
  readonly forgetRetainedShellOwners?: (
    input: TerminalRetainedShellOwnersInput,
  ) => Effect.Effect<TerminalForgetRetainedShellOwnersResult, TerminalError>;
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
  readonly write: (
    input: TerminalWriteInput,
    options?: { readonly origin?: "client" | "internal" },
  ) => Effect.Effect<void, TerminalError>;

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

  /** Stage a pasted/dropped file on the session's own machine (never a client-chosen one). */
  readonly stagePasteFile?: (
    input: TerminalPasteStageInput,
  ) => Effect.Effect<TerminalPasteStageResult, TerminalPasteStageError>;

  /** Search the output terminals retain (newest lines first); scan on demand, no index. */
  readonly search?: (input: TerminalSearchInput) => Effect.Effect<TerminalSearchResult>;

  /**
   * Hold or release a terminal's PTY output for one delivery subscriber (producer flow control).
   * Succeeds with whether the running process supports pausing; unsupported adapters are bounded
   * by delivery overflow instead.
   */
  /**
   * One terminal's events for a mounted view: with `acceptScreen`, the host screen first and
   * live output cut at its sequence; the renderer counts as attached until `unsubscribe`.
   */
  readonly subscribeSession?: (
    input: {
      readonly threadId: string;
      readonly terminalId: string;
      readonly acceptScreen: boolean;
    },
    sink: TerminalSessionStreamSink,
  ) => Effect.Effect<TerminalSessionStreamHandle>;

  /** Restart one host terminal's idle timer; terminals without idle close are unchanged. */
  readonly keepOpen?: (input: TerminalKeepOpenInput) => Effect.Effect<void, TerminalError>;

  /** Lifecycle notices (`includeLifecycle`): idle warnings, host closes, limit refusals. */
  readonly subscribeLifecycle?: (
    listener: (notice: TerminalLifecycleNotice) => Effect.Effect<void>,
  ) => Effect.Effect<() => void>;

  readonly publishLifecycleNotice?: (notice: TerminalLifecycleNotice) => Effect.Effect<void>;

  /** "Close them": stop old-version hosts that can't be reconnected. */
  readonly closeDrainingHosts?: () => Effect.Effect<
    TerminalCloseDrainingHostsResult,
    TerminalError
  >;

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
