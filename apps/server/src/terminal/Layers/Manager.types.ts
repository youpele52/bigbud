import type { TerminalWorkSink } from "./Manager.workSignals.ts";
import type * as Effect from "effect/Effect";
import type { DirectShellLaunchOwnerStore } from "./DirectShellLaunch.owner";
import type * as Fiber from "effect/Fiber";
import type * as Option from "effect/Option";
import type { TerminalViewRegistry } from "../activity/terminalViewRegistry.ts";
import type { AppQuitIntentRecord } from "../../lifecycle/AppQuitIntent.ts";
import type { TerminalRecoveryModel } from "./TerminalRecoveryModel";
import type { TerminalModeTracker } from "./TerminalModeTracker";
import type { TerminalHistoryRetention } from "./Manager.history.retention";
import type { TerminalSessionHostState } from "./Manager.host.types.ts";
import type { TerminalEndedReason } from "@bigbud/contracts/workspace/terminal.limit.ts";
import type { RemoteAgentPtyLimitError } from "../../remote-agent/remoteAgentPtyClient.types.ts";

import type {
  TerminalCwdError,
  TerminalRuntimeLeaseError,
  TerminalDropPathMode,
  TerminalSessionStatus,
} from "@bigbud/contracts";
import type { ProviderKind } from "@bigbud/contracts/orchestration/orchestration.provider";
import type {
  PtyAdapterShape,
  PtyExitEvent,
  PtyHostWideControl,
  PtyProcess,
  PtySpawnHostLifecycle,
} from "../Services/PTY";
import type { TerminalSubprocessChecker } from "./Manager.shell";
import type { RemoteTerminalProcessInspector } from "./Manager.remote-inspection.ts";
import type { TerminalAgentDetector } from "./Manager.agentDetection";
import type { TerminalWslIdentity } from "@bigbud/contracts/workspace/terminal.wsl.ts";
import type { TerminalAgentIdentity } from "@bigbud/contracts/workspace/terminal.agentIdentity.ts";
import type {
  ShellLaunchIdentity,
  ShellUnconfirmedLaunch,
  ShellSelection,
} from "@bigbud/contracts/workspace/terminalShell.ts";
import type { LocalShellDiscoveryError } from "../Services/LocalShellProfiles";
import type {
  ShellProfileDiscoveryError,
  ShellProfileTarget,
  ShellProfileInventory,
} from "../Services/ShellProfiles";
import type {
  ResolvedShellProfileLaunch,
  ShellProfileResolutionError,
} from "./ShellProfiles.launch";

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
  recoveryModel?: TerminalRecoveryModel | undefined;
  /** Input-affecting modes since process birth; survives history truncation. */
  modeTracker?: TerminalModeTracker | undefined;
  recoveryOutputHeld?: boolean;
  hasDeliveryOutputHold?: (() => boolean) | undefined;
  recoveryResizeOutput?: { bytes: number; chunks: string[] } | undefined;
  wslIdentity?: TerminalWslIdentity | undefined;
  shellLaunchIdentity?: ShellLaunchIdentity | undefined;
  shellUnconfirmedLaunch?: ShellUnconfirmedLaunch | undefined;
  remoteShellPid?: number | undefined;
  remoteOwnerRecoveryRequired?: boolean;
  expectedRemoteResourceId?: string | undefined;
  restartPending?: boolean;
  stopPending?: boolean;
  reconcileOutputHold?: (() => void) | undefined;
  lifecyclePending?: boolean;
  observedExit?: { process: PtyProcess; event: PtyExitEvent } | undefined;
  lastRestartOperation?: { id: string; fingerprint: string; generation: string };
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
  /** The history begins at a line cut with SGR and modes re-asserted, not at a full baseline. */
  historyTrimmed?: boolean;
  /** Boundary scan and visible-text search tail kept by history retention. */
  historyRetention?: TerminalHistoryRetention | undefined;
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
  unsubscribeError?: (() => void) | null;
  subprocessAssessedGeneration?: string | undefined;
  subprocessAssessedEpoch?: number | undefined;
  hasRunningSubprocess: boolean;
  activeAgentProvider: ProviderKind | null;
  activeAgent?: TerminalAgentIdentity | null;
  agentIdentityMisses: number;
  runtimeEnv: Record<string, string> | null;
  /** Host-backed process state (plan S3); absent for in-process terminals. */
  host?: TerminalSessionHostState | undefined;
  /** Why the last process ended, when the host or the user ended it (§9.2). */
  endedReason?: TerminalEndedReason | undefined;
  /** The host refused the last spawn at its live limit; the open fails with it. */
  hostLimitRefusal?: RemoteAgentPtyLimitError | undefined;
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
  shellProfileLaunch?: ResolvedShellProfileLaunch | null;
  threadId: string;
  terminalId: string;
  executionTargetId?: string;
  cwd: string;
  worktreePath?: string | null;
  cols: number;
  rows: number;
  env?: Record<string, string>;
  /** Host create options for this spawn only (limit eviction). */
  hostLifecycle?: PtySpawnHostLifecycle | undefined;
}

export interface TerminalManagerOptions {
  /** Terminal recency and finished-work reporting (Enter, OSC 133, poll, agent markers). */
  workSink?: TerminalWorkSink | undefined;
  /** Extra environment for local POSIX pane shells (bigbud shell integration); never remote. */
  shellIntegrationEnv?:
    | ((base: NodeJS.ProcessEnv) => Record<string, string> | undefined)
    | undefined;
  getLocalShellDefault?: (() => ShellSelection | undefined) | undefined;
  listLocalShellProfiles?:
    | (() => Effect.Effect<ShellProfileInventory, ShellProfileDiscoveryError>)
    | undefined;
  directShellOwners?: DirectShellLaunchOwnerStore;
  listShellProfiles?: (
    target: ShellProfileTarget,
  ) => Effect.Effect<ShellProfileInventory, ShellProfileDiscoveryError>;
  preflightRemoteShellProfile?: (
    executionTargetId: string,
  ) => Effect.Effect<void, ShellProfileDiscoveryError>;
  resolveShellProfile?: (
    selection: ShellSelection,
    target: ShellProfileTarget,
  ) => Effect.Effect<
    ResolvedShellProfileLaunch | null,
    LocalShellDiscoveryError | ShellProfileDiscoveryError | ShellProfileResolutionError
  >;
  resolveRuntimePathIdentity?: (
    cwd: string,
  ) => Effect.Effect<RuntimePathIdentity, TerminalCwdError>;
  logsDir: string;
  historyLineLimit?: number;
  ptyAdapter: PtyAdapterShape;
  shellResolver?: () => string;
  subprocessChecker?: TerminalSubprocessChecker;
  agentDetector?: TerminalAgentDetector;
  remoteProcessInspector?: RemoteTerminalProcessInspector;
  subprocessPollIntervalMs?: number;
  processKillGraceMs?: number;
  maxRetainedInactiveSessions?: number;
  /**
   * Remote hosts of kept managed terminals no session holds (plan §14 quit); defaults to the
   * configured remote agents' durable owners over live connections, with the terminal host on.
   */
  remoteKeptTerminalHosts?: () => Promise<ReadonlyArray<PtyHostWideControl>>;
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
  /** View reports for host view-state pushes; the process-wide registry by default. */
  views?: TerminalViewRegistry | undefined;
  /** The "Keep terminals running after quitting" setting (plan §11.4). */
  keepRunningAfterQuit?: (() => boolean) | undefined;
  onSettingsChange?: ((listener: () => void) => () => void) | undefined;
  /** The desktop's acknowledged quit intent, read once on shutdown (plan §14). */
  resolveQuitIntent?: Effect.Effect<Option.Option<AppQuitIntentRecord>> | undefined;
}

export interface RuntimePathIdentity {
  readonly canonicalPath: string;
  readonly device: number;
  readonly inode: number;
}
