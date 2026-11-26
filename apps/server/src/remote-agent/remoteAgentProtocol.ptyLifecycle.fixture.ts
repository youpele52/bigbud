import { readFileSync } from "node:fs";

import { REMOTE_AGENT_PROTOCOL_MINOR, type RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import {
  REMOTE_AGENT_PTY_LIMIT_REACHED,
  REMOTE_AGENT_SNAPSHOT_BUSY,
  type RemoteAgentHostPolicy,
  type RemoteAgentPtyLifecycleNotice,
} from "./remoteAgentProtocol.ptyLifecycle.ts";

/** Shared goldens; fixtures mirror `crates/bigbud-protocol/src/frame/pty_lifecycle.fixtures.rs`. */
export const lifecycleGoldens: Readonly<Record<string, string>> = Object.fromEntries(
  readFileSync(
    new URL("../../../../protocol/remote-agent/v1.golden.frames", import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.split("=", 2) as [string, string]),
);

export const hexBytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));

/** Byte `i` of a maximum-size transfer is `i % 251` (matches the Rust fill). */
export function fill(start: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (start + index) % 251;
  return bytes;
}

/** `<name>_head`, the fill, then `<name>_tail` when present. */
export function largeGolden(name: string, fillStart: number, fillLength: number): Uint8Array {
  const head = hexBytes(lifecycleGoldens[`${name}_head`]!);
  const tail = hexBytes(lifecycleGoldens[`${name}_tail`] ?? "");
  const bytes = new Uint8Array(head.length + fillLength + tail.length);
  bytes.set(head, 0);
  bytes.set(fill(fillStart, fillLength), head.length);
  bytes.set(tail, head.length + fillLength);
  return bytes;
}

const policy: RemoteAgentHostPolicy = {
  lifecycleEnabled: true,
  idleCloseMs: 600_000,
  idleWarningMs: 60_000,
  maxLivePtys: 24,
  orphanCloseMs: 0,
  memoryPressureEnabled: true,
  memoryAvailableLowPercent: 8,
  memoryAvailableCriticalPercent: 4,
  hostRssLowBytes: 512 * 1024 * 1024,
  hostRssCriticalBytes: 768 * 1024 * 1024,
  terminalRssLowPercent: 50,
  terminalRssCriticalPercent: 70,
  revision: 3,
};

const notice = (noticeId: number, kind: string): RemoteAgentPtyLifecycleNotice => ({
  noticeId,
  ptyId: "pty-1",
  kind,
  closesAtMs: kind === "idle_warning" ? 1_700_000_600_000 : 0,
  occurredAtMs: 1_700_000_540_000,
});

const control = { errorCode: "", errorMessage: "" };

export const lifecycleGoldenFrames: ReadonlyArray<readonly [string, RemoteAgentFrame]> = [
  [
    "pty_screen_snapshot_request",
    {
      type: "ptyScreenSnapshotRequest",
      value: {
        requestId: "snap-1",
        ptyId: "pty-1",
        maxAnsiUnits: 1_048_576,
        maxUtf8Bytes: 3 * 1024 * 1024,
        maxScrollbackRows: 1_000,
        attachRenderer: true,
      },
    },
  ],
  [
    "pty_screen_snapshot_header_busy",
    {
      type: "ptyScreenSnapshotHeader",
      value: {
        requestId: "snap-1",
        ptyId: "pty-1",
        accepted: false,
        errorCode: REMOTE_AGENT_SNAPSHOT_BUSY,
        throughSequence: 0,
        cols: 0,
        rows: 0,
        scrollbackRows: 0,
        alternateScreen: false,
        fidelity: "",
        modelState: "",
        chunkCount: 0,
        totalAnsiBytes: 0,
        pendingEscapeTail: new Uint8Array(),
        sha256: new Uint8Array(),
        trimmedRows: 0,
        errorMessage: "",
      },
    },
  ],
  [
    "pty_screen_snapshot_chunk",
    {
      type: "ptyScreenSnapshotChunk",
      value: {
        requestId: "snap-1",
        index: 1,
        last: true,
        bytes: new TextEncoder().encode("\u001b[0m$ "),
      },
    },
  ],
  [
    "pty_activity",
    {
      type: "ptyActivity",
      value: {
        ptyId: "pty-1",
        idleBusy: true,
        pressureBusy: true,
        sidebarBusy: false,
        reasons: ["foreground_program", ""],
        lastInputMs: 1_700_000_000_000,
        lastOutputMs: 1_700_000_001_000,
        quietSinceMs: 1_700_000_001_000,
      },
    },
  ],
  ["pty_lifecycle_notice", { type: "ptyLifecycleNotice", value: notice(7, "idle_warning") }],
  [
    "host_policy_update_request",
    { type: "hostPolicyUpdateRequest", value: { requestId: "policy-1", policy } },
  ],
  [
    "host_policy_update_response",
    {
      type: "hostPolicyUpdateResponse",
      value: { requestId: "policy-1", accepted: true, ...control, effective: policy },
    },
  ],
  [
    "pty_view_state_request",
    {
      type: "ptyViewStateRequest",
      value: {
        requestId: "view-1",
        ptyId: "pty-1",
        viewState: "hidden",
        rendererAttached: false,
        ownerBusyHint: "unknown",
        themeFg: "#d4d4d4",
        themeBg: "#1e1e1e",
        ackedSequence: 42,
      },
    },
  ],
  [
    "pty_view_state_response",
    {
      type: "ptyViewStateResponse",
      value: { requestId: "view-1", ptyId: "pty-1", accepted: true, ...control },
    },
  ],
  [
    "pty_keep_open_request",
    { type: "ptyKeepOpenRequest", value: { requestId: "keep-1", ptyId: "pty-1" } },
  ],
  [
    "pty_keep_open_response",
    {
      type: "ptyKeepOpenResponse",
      value: {
        requestId: "keep-1",
        ptyId: "pty-1",
        accepted: false,
        errorCode: "PTY_NOT_FOUND",
        errorMessage: "unknown PTY",
      },
    },
  ],
  [
    "pty_close_all_request",
    {
      type: "ptyCloseAllRequest",
      value: { requestId: "close-all-1", reason: "update", managedOnly: true },
    },
  ],
  [
    "pty_close_all_response",
    {
      type: "ptyCloseAllResponse",
      value: { requestId: "close-all-1", accepted: true, ...control, closedCount: 5 },
    },
  ],
  [
    "host_resource_report",
    {
      type: "hostResourceReport",
      value: {
        sampledAtMs: 1_700_000_000_000,
        memoryLevel: "low",
        memoryAvailableBytes: 2 ** 30,
        memoryTotalBytes: 16 * 2 ** 30,
        hostRssBytes: 96 * 2 ** 20,
        terminalRssBytes: 3 * 2 ** 30,
        screenModelBytes: 40 * 2 ** 20,
        spoolBytes: 200 * 2 ** 20,
        livePtys: 12,
        managedLivePtys: 10,
        maxLivePtys: 24,
      },
    },
  ],
  [
    "host_notice_replay_request",
    {
      type: "hostNoticeReplayRequest",
      value: { requestId: "replay-1", expectedEpoch: "epoch-1", afterNoticeId: 6 },
    },
  ],
  [
    "host_notice_replay_response",
    {
      type: "hostNoticeReplayResponse",
      value: {
        requestId: "replay-1",
        agentEpoch: "epoch-1",
        accepted: true,
        errorCode: "",
        notices: [notice(7, "idle_warning"), notice(8, "idle_closed")],
        gap: true,
      },
    },
  ],
  [
    "pty_create_lifecycle",
    {
      type: "ptyCreateRequest",
      value: {
        requestId: "create-1",
        ptyId: "pty-2",
        requestDigest: new Uint8Array([1, 2, 3]),
        workspaceHandle: "workspace-1",
        cwd: "",
        shell: "/bin/zsh",
        args: [],
        cols: 80,
        rows: 24,
        evictPtyId: "pty-1",
        activitySource: "host",
        screenScrollbackRows: 1_000,
        spool: true,
        localLaunch: true,
        lifecycleManaged: true,
      },
    },
  ],
  [
    "pty_create_limit_reached",
    {
      type: "ptyCreateResponse",
      value: {
        requestId: "create-1",
        ptyId: "pty-2",
        accepted: false,
        pid: 0,
        errorCode: REMOTE_AGENT_PTY_LIMIT_REACHED,
        errorMessage: "",
        limit: 24,
        liveCount: 24,
        evictionCandidatePtyId: "pty-1",
        evictedPtyId: "pty-0",
      },
    },
  ],
  [
    "pty_list_response_lifecycle",
    {
      type: "ptyListResponse",
      value: {
        requestId: "list-1",
        agentEpoch: "epoch-1",
        entries: [
          {
            ptyId: "pty-1",
            requestDigest: new Uint8Array(),
            state: "running",
            pid: 42,
            nextSequence: 2,
            firstRetainedSequence: 0,
            verifiedExit: false,
            launchStatus: "",
            activityState: "idle",
            lastUsedMs: 1_700_000_000_000,
            screenAvailable: true,
            lost: true,
            lifecycleManaged: true,
          },
        ],
        nextAfterPtyId: "",
        snapshotId: "",
        accepted: true,
        errorCode: "",
      },
    },
  ],
  [
    "agent_hello_process_identity",
    {
      type: "agentHello",
      value: {
        protocolMajor: 1,
        protocolMinor: REMOTE_AGENT_PROTOCOL_MINOR,
        agentVersion: "0.1.0",
        buildDigest: "",
        os: "",
        architecture: "",
        agentInstanceId: "",
        agentEpoch: "epoch-1",
        capabilities: [],
        maxFrameBytes: 0,
        maxOperationOutputBytes: 0,
        maxJournalBytes: 0,
        processId: 4_242,
        processStartTimeMs: 1_700_000_000_123,
      },
    },
  ],
];
