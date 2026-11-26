/**
 * Protocol 1.9 terminal lifecycle frames (`pty_lifecycle.proto`, frames 80-95). Each frame is
 * gated by a capability that agents advertise only once they implement it.
 */
export const REMOTE_AGENT_TERMINAL_SCREEN_CAPABILITY = "terminal.screen";
export const REMOTE_AGENT_TERMINAL_LIFECYCLE_CAPABILITY = "terminal.lifecycle";
export const REMOTE_AGENT_TERMINAL_SPOOL_CAPABILITY = "terminal.spool";
export const REMOTE_AGENT_TERMINAL_QUERY_RESPONDER_CAPABILITY = "terminal.query-responder";
/** Local terminal host only. */
export const REMOTE_AGENT_TERMINAL_LOCAL_LAUNCH_CAPABILITY = "terminal.local-launch";

/** Snapshot transport bounds; the client validates every transfer against them. */
export const REMOTE_AGENT_SNAPSHOT_CHUNK_MAX_BYTES = 192 * 1024;
export const REMOTE_AGENT_SNAPSHOT_MAX_CHUNKS = 16;
export const REMOTE_AGENT_SNAPSHOT_MAX_TOTAL_BYTES = 3 * 1024 * 1024;
export const REMOTE_AGENT_SNAPSHOT_MAX_ESCAPE_TAIL_BYTES = 16 * 1024;
export const REMOTE_AGENT_SNAPSHOT_DEFAULT_MAX_ANSI_UNITS = 1_048_576;

/** Error codes: a busy snapshot FIFO (retry after 250 ms), the PTY limit, and an old agent. */
export const REMOTE_AGENT_SNAPSHOT_BUSY = "SNAPSHOT_BUSY";
export const REMOTE_AGENT_PTY_LIMIT_REACHED = "PTY_LIMIT_REACHED";
export const REMOTE_AGENT_LIFECYCLE_UNSUPPORTED = "UNSUPPORTED";

/** Additive `PtyCreateRequest` fields 12-17; absent values keep legacy behavior. */
export interface RemoteAgentPtyCreateLifecycleFields {
  /** Requires terminal.lifecycle v1: atomically close this managed, hidden PTY first. */
  readonly evictPtyId?: string;
  /** `host` (default) or `owner-hint` for Direct SSH owners. */
  readonly activitySource?: string;
  /** Requires terminal.screen v1; absent means the host default (1,000). */
  readonly screenScrollbackRows?: number;
  /** Requires terminal.spool v1. */
  readonly spool?: boolean;
  /** Requires terminal.local-launch v1. */
  readonly localLaunch?: boolean;
  /** Opts this PTY into host lifecycle policy and the limit. */
  readonly lifecycleManaged?: boolean;
}

/** Additive `PtyCreateResponse` fields 8-11, set with `PTY_LIMIT_REACHED` or an eviction. */
export interface RemoteAgentPtyCreateLimitFields {
  readonly limit?: number;
  readonly liveCount?: number;
  readonly evictionCandidatePtyId?: string;
  readonly evictedPtyId?: string;
}

/** Additive `PtyInventoryEntry` fields 9-13 (terminal.lifecycle v1). */
export interface RemoteAgentPtyInventoryLifecycleFields {
  readonly activityState?: string;
  readonly lastUsedMs?: number;
  readonly screenAvailable?: boolean;
  readonly lost?: boolean;
  readonly lifecycleManaged?: boolean;
}

/** Additive `AgentHello` fields 13-14, used only to verify a PID before signalling it. */
export interface RemoteAgentHelloProcessFields {
  readonly processId?: number;
  /** Process start time in Unix milliseconds. */
  readonly processStartTimeMs?: number;
}

export interface RemoteAgentPtyScreenSnapshotRequest {
  readonly requestId: string;
  readonly ptyId: string;
  /** UTF-16 units; 0 means the host default. */
  readonly maxAnsiUnits: number;
  /** UTF-8 bytes; 0 means the host default (3 MiB). */
  readonly maxUtf8Bytes: number;
  readonly maxScrollbackRows: number;
  /** Atomically moves the query-responder cut to this snapshot's `throughSequence`. */
  readonly attachRenderer: boolean;
}

export interface RemoteAgentPtyScreenSnapshotHeader {
  readonly requestId: string;
  readonly ptyId: string;
  readonly accepted: boolean;
  readonly errorCode: string;
  readonly throughSequence: number;
  readonly cols: number;
  readonly rows: number;
  readonly scrollbackRows: number;
  readonly alternateScreen: boolean;
  /** `full` | `trimmed` | `partial`. */
  readonly fidelity: string;
  /** `live` | `cold` | `invalid`. */
  readonly modelState: string;
  readonly chunkCount: number;
  readonly totalAnsiBytes: number;
  readonly pendingEscapeTail: Uint8Array;
  /** SHA-256 of the concatenated chunk bytes in index order. */
  readonly sha256: Uint8Array;
  readonly trimmedRows: number;
  readonly errorMessage: string;
}

export interface RemoteAgentPtyScreenSnapshotChunk {
  readonly requestId: string;
  readonly index: number;
  readonly last: boolean;
  readonly bytes: Uint8Array;
}

export interface RemoteAgentPtyActivity {
  readonly ptyId: string;
  readonly idleBusy: boolean;
  readonly pressureBusy: boolean;
  readonly sidebarBusy: boolean;
  readonly reasons: ReadonlyArray<string>;
  readonly lastInputMs: number;
  readonly lastOutputMs: number;
  readonly quietSinceMs: number;
}

export interface RemoteAgentPtyLifecycleNotice {
  readonly noticeId: number;
  readonly ptyId: string;
  /** `idle_warning`, `idle_closed`, `limit_closed`, ... (see `pty_lifecycle.proto`). */
  readonly kind: string;
  readonly closesAtMs: number;
  readonly occurredAtMs: number;
}

/** Zero numeric values mean the host default; the host returns the clamped effective values. */
export interface RemoteAgentHostPolicy {
  readonly lifecycleEnabled: boolean;
  readonly idleCloseMs: number;
  /** Lead time before the idle close at which `idle_warning` is emitted. */
  readonly idleWarningMs: number;
  readonly maxLivePtys: number;
  readonly orphanCloseMs: number;
  readonly memoryPressureEnabled: boolean;
  readonly memoryAvailableLowPercent: number;
  readonly memoryAvailableCriticalPercent: number;
  readonly hostRssLowBytes: number;
  readonly hostRssCriticalBytes: number;
  readonly terminalRssLowPercent: number;
  readonly terminalRssCriticalPercent: number;
  readonly revision: number;
}

export interface RemoteAgentHostPolicyUpdateRequest {
  readonly requestId: string;
  readonly policy: RemoteAgentHostPolicy;
}

export interface RemoteAgentHostPolicyUpdateResponse {
  readonly requestId: string;
  readonly accepted: boolean;
  readonly errorCode: string;
  readonly errorMessage: string;
  /** All defaults when the host refused the update. */
  readonly effective: RemoteAgentHostPolicy;
}

/** Full view state; each request replaces the previous one for the PTY. */
export interface RemoteAgentPtyViewStateRequest {
  readonly requestId: string;
  readonly ptyId: string;
  /** `visible` | `hidden`. */
  readonly viewState: string;
  readonly rendererAttached: boolean;
  /** `busy` | `idle` | `unknown`; empty means no owner hint. */
  readonly ownerBusyHint: string;
  readonly themeFg: string;
  readonly themeBg: string;
  /** With `rendererAttached = false`: the last output sequence the view parsed. */
  readonly ackedSequence: number;
}

export interface RemoteAgentPtyLifecycleControlResponse {
  readonly requestId: string;
  readonly ptyId: string;
  readonly accepted: boolean;
  readonly errorCode: string;
  readonly errorMessage: string;
}

export interface RemoteAgentPtyKeepOpenRequest {
  readonly requestId: string;
  readonly ptyId: string;
}

export interface RemoteAgentPtyCloseAllRequest {
  readonly requestId: string;
  /** `quit` | `update`. */
  readonly reason: string;
  readonly managedOnly: boolean;
}

export interface RemoteAgentPtyCloseAllResponse {
  readonly requestId: string;
  readonly accepted: boolean;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly closedCount: number;
}

export interface RemoteAgentHostResourceReport {
  readonly sampledAtMs: number;
  /** `normal` | `low` | `critical`. */
  readonly memoryLevel: string;
  readonly memoryAvailableBytes: number;
  readonly memoryTotalBytes: number;
  readonly hostRssBytes: number;
  readonly terminalRssBytes: number;
  readonly screenModelBytes: number;
  readonly spoolBytes: number;
  readonly livePtys: number;
  readonly managedLivePtys: number;
  readonly maxLivePtys: number;
}

export interface RemoteAgentHostNoticeReplayRequest {
  readonly requestId: string;
  readonly expectedEpoch: string;
  readonly afterNoticeId: number;
}

export interface RemoteAgentHostNoticeReplayResponse {
  readonly requestId: string;
  readonly agentEpoch: string;
  readonly accepted: boolean;
  readonly errorCode: string;
  readonly notices: ReadonlyArray<RemoteAgentPtyLifecycleNotice>;
  /** True when notices after `afterNoticeId` were already evicted from the ring. */
  readonly gap: boolean;
}

export type RemoteAgentPtyLifecycleFrame =
  | {
      readonly type: "ptyScreenSnapshotRequest";
      readonly value: RemoteAgentPtyScreenSnapshotRequest;
    }
  | { readonly type: "ptyScreenSnapshotHeader"; readonly value: RemoteAgentPtyScreenSnapshotHeader }
  | { readonly type: "ptyScreenSnapshotChunk"; readonly value: RemoteAgentPtyScreenSnapshotChunk }
  | { readonly type: "ptyActivity"; readonly value: RemoteAgentPtyActivity }
  | { readonly type: "ptyLifecycleNotice"; readonly value: RemoteAgentPtyLifecycleNotice }
  | {
      readonly type: "hostPolicyUpdateRequest";
      readonly value: RemoteAgentHostPolicyUpdateRequest;
    }
  | {
      readonly type: "hostPolicyUpdateResponse";
      readonly value: RemoteAgentHostPolicyUpdateResponse;
    }
  | { readonly type: "ptyViewStateRequest"; readonly value: RemoteAgentPtyViewStateRequest }
  | {
      readonly type: "ptyViewStateResponse";
      readonly value: RemoteAgentPtyLifecycleControlResponse;
    }
  | { readonly type: "ptyKeepOpenRequest"; readonly value: RemoteAgentPtyKeepOpenRequest }
  | {
      readonly type: "ptyKeepOpenResponse";
      readonly value: RemoteAgentPtyLifecycleControlResponse;
    }
  | { readonly type: "ptyCloseAllRequest"; readonly value: RemoteAgentPtyCloseAllRequest }
  | { readonly type: "ptyCloseAllResponse"; readonly value: RemoteAgentPtyCloseAllResponse }
  | { readonly type: "hostResourceReport"; readonly value: RemoteAgentHostResourceReport }
  | {
      readonly type: "hostNoticeReplayRequest";
      readonly value: RemoteAgentHostNoticeReplayRequest;
    }
  | {
      readonly type: "hostNoticeReplayResponse";
      readonly value: RemoteAgentHostNoticeReplayResponse;
    };
