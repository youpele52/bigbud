/**
 * PtyAdapter - Terminal PTY adapter service contract.
 *
 * Defines the process primitives required by terminal session management
 * without binding to a specific PTY implementation.
 *
 * @module PtyAdapter
 */
import { Effect, Schema, ServiceMap } from "effect";
import type { RemoteAgentShellLaunch } from "../../remote-agent/remoteAgentShellLaunch.ts";
import type { ShellUnconfirmedLaunch } from "@bigbud/contracts/workspace/terminalShell.ts";
import type { ShellLaunchIdentity } from "@bigbud/contracts/workspace/terminalShell.ts";
import type { OwnedPtyHostControls, OwnedPtyRuntime } from "./OwnedPtyRuntime.ts";

/**
 * PtyError - Error type for PTY adapter operations.
 */
export class PtySpawnError extends Schema.TaggedErrorClass<PtySpawnError>()("PtySpawnError", {
  adapter: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

/** Loss of the exact native SSH owner channel; never evidence of child exit. */
export class NativeSshPtyHostLostError extends Error {
  constructor() {
    super("sshOwnerUnavailable: The native SSH terminal host was lost; its pane stays reserved.");
  }
}

export interface PtyExitEvent {
  exitCode: number;
  signal: number | null;
}

export interface PtyProcess {
  /** PID belongs to the Rust execution host, never its proxy; ownedRuntime declares its namespace. */
  readonly pidDomain?: "remote";
  /** Attached to an existing process; earlier output is unknown unless explicitly replayed. */
  readonly recovered?: boolean;
  /** The exact native lease delivers a verified gap-free byte replay from process birth on onData. */
  readonly recoveredHistoryFromStart?: true;
  /** Durable resource identity for generation-fenced attach-only discovery. */
  readonly remoteResourceId?: string;
  /** Explicit remote launch evidence only; missing evidence is unknown, never confirmed. */
  readonly launchStatus?: "unconfirmed" | undefined;
  /** Requested intent plus matched launch evidence, never actual executable identity. */
  readonly shellUnconfirmedLaunch?: ShellUnconfirmedLaunch | undefined;
  /** Explicit replacement must wait for definitive exit and durable ownership release. */
  readonly prepareRestart?: () => Promise<void>;
  readonly detach?: () => void;
  /** Fresh same-resource confirmation; cancellation retires only this observer. */
  readonly reconnectRemote?: ((signal?: AbortSignal) => Promise<void>) | undefined;
  /** Acknowledged per-resource unsubscribe; leaves the remote process alive. */
  readonly detachRemote?: () => Promise<void>;
  readonly pid: number;
  write(data: string): void;
  /**
   * Producer flow control: stop reading output so the child blocks on a full PTY buffer, then
   * resume. Optional; adapters without it are bounded by delivery overflow instead.
   */
  readonly pause?: () => void;
  readonly resume?: () => void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): () => void;
  /** Fatal I/O failure is not exit evidence; implementations may replay a latched failure. */
  readonly onError?: (callback: (error: Error) => void) => () => void;
  onExit(callback: (event: PtyExitEvent) => void): () => void;
  /** Host output with its per-PTY sequence; every applied sequence is reported, even empty text. */
  readonly onSequencedData?: (callback: (event: PtySequencedData) => void) => () => void;
  /** Host screen copies (terminal.screen); absent for node-pty. */
  readonly screen?: PtyScreenControl;
  /** Host lifecycle controls (terminal.lifecycle); absent for node-pty. */
  readonly lifecycle?: PtyLifecycleControl;
  /**
   * Set when the process ended without a verified exit because its host or connection went
   * away (for example `remote-service-restarted`); the child's outcome is unknown.
   */
  readonly interruptionReason?: string | undefined;
}

export interface PtySequencedData {
  readonly sequence: number;
  /** Text decoded through `sequence`; a split UTF-8 character completes with a later sequence. */
  readonly data: string;
}

/** Capabilities of the connection that currently carries this PTY; they can change on reconnect. */
export interface PtyHostCapabilities {
  readonly screen: boolean;
  readonly lifecycle: boolean;
  readonly spool: boolean;
  readonly queryResponder: boolean;
  readonly localLaunch: boolean;
}

export interface PtyScreenSnapshotInput {
  /** Atomically moves the host query-responder cut to this snapshot (§8.9). */
  readonly attachRenderer: boolean;
  readonly maxAnsiUnits?: number;
  readonly maxUtf8Bytes?: number;
  /** 0 or absent means the model's full retained scrollback. */
  readonly maxScrollbackRows?: number;
  readonly signal?: AbortSignal;
}

/** A verified, fully reassembled host screen copy. */
export interface PtyScreenSnapshot {
  readonly throughSequence: number;
  readonly cols: number;
  readonly rows: number;
  readonly scrollbackRows: number;
  readonly alternateScreen: boolean;
  readonly fidelity: "full" | "trimmed" | "partial";
  readonly modelState: "live" | "cold" | "invalid";
  readonly trimmedRows: number;
  readonly ansi: Uint8Array;
  readonly pendingEscapeTail: Uint8Array;
}

export interface PtyScreenControl {
  readonly capabilities: () => PtyHostCapabilities;
  /** Rejects with code `UNSUPPORTED` when the host lacks terminal.screen. */
  readonly snapshot: (input: PtyScreenSnapshotInput) => Promise<PtyScreenSnapshot>;
}

export interface PtyViewState {
  readonly viewState: "visible" | "hidden";
  readonly rendererAttached: boolean;
  readonly ownerBusyHint?: "busy" | "idle" | "unknown";
  readonly themeFg?: string;
  readonly themeBg?: string;
  /** With `rendererAttached = false`: the last output sequence the view parsed (§8.9). */
  readonly ackedSequence?: number;
}

export interface PtyHostActivity {
  readonly idleBusy: boolean;
  readonly pressureBusy: boolean;
  readonly sidebarBusy: boolean;
  readonly reasons: ReadonlyArray<string>;
  readonly lastInputMs: number;
  readonly lastOutputMs: number;
  readonly quietSinceMs: number;
}

export interface PtyHostLifecycleNotice {
  readonly noticeId: number;
  readonly kind: string;
  readonly closesAtMs: number;
  readonly occurredAtMs: number;
}

export interface PtyLifecycleControl {
  readonly capabilities: () => PtyHostCapabilities;
  /** The PTY the host closed to admit this one (limit eviction), when it reported one. */
  readonly evictedPtyId?: string | undefined;
  /** Full state, latest wins; superseded pushes settle with the push that replaced them. */
  readonly setViewState: (state: PtyViewState, signal?: AbortSignal) => Promise<void>;
  readonly keepOpen: (signal?: AbortSignal) => Promise<void>;
  readonly onActivity: (callback: (activity: PtyHostActivity) => void) => () => void;
  readonly onNotice: (callback: (notice: PtyHostLifecycleNotice) => void) => () => void;
  /**
   * Host-wide controls of the remote-agent host that carries this PTY, over its current
   * connection (policy push, quit close-all, host events). Remote-agent PTYs only; a local host
   * is driven through its runtime's generations instead.
   */
  readonly hostWide?: PtyHostWideControl;
}

export interface PtyHostWideControl extends Pick<
  OwnedPtyHostControls,
  "updatePolicy" | "closeAll"
> {
  /** Identifies the connection that now carries the PTY; it changes on every reconnect. */
  readonly connectionKey: () => string;
  /** Host-wide events (notices of PTYs whose exit came first) on the current connection. */
  readonly subscribe: OwnedPtyHostControls["subscribe"];
}

/** Additive host create options; ignored where the host lacks the capability. */
export interface PtySpawnHostLifecycle {
  readonly lifecycleManaged?: boolean;
  readonly activitySource?: "host" | "owner-hint";
  /** Host `pty_id` to close atomically before admitting this one (limit eviction). */
  readonly evictPtyId?: string;
}

export interface PtySpawnInput {
  readonly ownerKey?: string;
  readonly recoverOnly?: boolean;
  /** Explicit user restart may replace a confirmed terminal owner, never a live reservation. */
  readonly replaceTerminalOwner?: boolean;
  /** Caller cancellation for attach-only recovery; never authority to stop the child. */
  readonly recoverySignal?: AbortSignal;
  readonly expectedRemoteResourceId?: string | undefined;
  /** Internal execution-host-validated intent; client input must never supply executable/argv. */
  readonly shellLaunch?: RemoteAgentShellLaunch;
  /** Server-owned profile selection, never client-supplied executable/argv. */
  readonly shellProfile?: ShellLaunchIdentity;
  shell: string;
  args?: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
  readonly executionTargetId?: string;
  readonly remoteCwd?: string;
  readonly hostLifecycle?: PtySpawnHostLifecycle;
}

/**
 * PtyAdapterShape - Service API for spawning and controlling PTY processes.
 */
export interface PtyAdapterShape {
  readonly ownedRuntimeForTarget?: (executionTargetId: string) => OwnedPtyRuntime | undefined;
  /**
   * Spawn a PTY process for a terminal session.
   */
  spawn(input: PtySpawnInput): Effect.Effect<PtyProcess, PtySpawnError>;
}

/**
 * PtyAdapter - Service tag for PTY process integration.
 */
export class PtyAdapter extends ServiceMap.Service<PtyAdapter, PtyAdapterShape>()(
  "t3/terminal/Services/PTY/PtyAdapter",
) {}
