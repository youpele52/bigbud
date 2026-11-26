import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import type { RemoteAgentPtyLifecycleFrame } from "./remoteAgentProtocol.ptyLifecycle.ts";
import {
  decodeTableExtension,
  decodeTableFrame,
  encodeTableFrame,
  type TableFrames,
  type TableSchema,
} from "./remoteAgentProtocol.codec.table.ts";
import { decodeMessage } from "./remoteAgentProtocol.codec.wire.ts";

/** Additive fields on pre-1.9 messages; legacy decoders skip them, so they merge in here. */
export const PTY_CREATE_REQUEST_LIFECYCLE_FIELDS: TableSchema = [
  [12, "evictPtyId", "string"],
  [13, "activitySource", "string"],
  [14, "screenScrollbackRows", "uint"],
  [15, "spool", "bool"],
  [16, "localLaunch", "bool"],
  [17, "lifecycleManaged", "bool"],
  [18, "threadId", "string"],
  [19, "paneId", "string"],
  [20, "paneKind", "string"],
];
export const PTY_CREATE_RESPONSE_LIMIT_FIELDS: TableSchema = [
  [8, "limit", "uint"],
  [9, "liveCount", "uint"],
  [10, "evictionCandidatePtyId", "string"],
  [11, "evictedPtyId", "string"],
];
export const PTY_INVENTORY_LIFECYCLE_FIELDS: TableSchema = [
  [9, "activityState", "string"],
  [10, "lastUsedMs", "uint"],
  [11, "screenAvailable", "bool"],
  [12, "lost", "bool"],
  [13, "lifecycleManaged", "bool"],
];
export const AGENT_HELLO_PROCESS_FIELDS: TableSchema = [
  [13, "processId", "uint"],
  [14, "processStartTimeMs", "uint"],
];

const CONTROL_RESPONSE: TableSchema = [
  [1, "requestId", "string"],
  [2, "ptyId", "string"],
  [3, "accepted", "bool"],
  [4, "errorCode", "string"],
  [5, "errorMessage", "string"],
];
const NOTICE: TableSchema = [
  [1, "noticeId", "uint"],
  [2, "ptyId", "string"],
  [3, "kind", "string"],
  [4, "closesAtMs", "uint"],
  [5, "occurredAtMs", "uint"],
];
const HOST_POLICY: TableSchema = [
  [1, "lifecycleEnabled", "bool"],
  [2, "idleCloseMs", "uint"],
  [3, "idleWarningMs", "uint"],
  [4, "maxLivePtys", "uint"],
  [5, "orphanCloseMs", "uint"],
  [6, "memoryPressureEnabled", "bool"],
  [7, "memoryAvailableLowPercent", "uint"],
  [8, "memoryAvailableCriticalPercent", "uint"],
  [9, "hostRssLowBytes", "uint"],
  [10, "hostRssCriticalBytes", "uint"],
  [11, "terminalRssLowPercent", "uint"],
  [12, "terminalRssCriticalPercent", "uint"],
  [13, "revision", "uint"],
];

/** Field tables mirror `protocol/remote-agent/pty_lifecycle.proto`; frame numbers are 80-95. */
const FRAMES: TableFrames<RemoteAgentPtyLifecycleFrame["type"]> = [
  [
    80,
    "ptyScreenSnapshotRequest",
    [
      [1, "requestId", "string"],
      [2, "ptyId", "string"],
      [3, "maxAnsiUnits", "uint"],
      [4, "maxUtf8Bytes", "uint"],
      [5, "maxScrollbackRows", "uint"],
      [6, "attachRenderer", "bool"],
    ],
  ],
  [
    81,
    "ptyScreenSnapshotHeader",
    [
      [1, "requestId", "string"],
      [2, "ptyId", "string"],
      [3, "accepted", "bool"],
      [4, "errorCode", "string"],
      [5, "throughSequence", "uint"],
      [6, "cols", "uint"],
      [7, "rows", "uint"],
      [8, "scrollbackRows", "uint"],
      [9, "alternateScreen", "bool"],
      [10, "fidelity", "string"],
      [11, "modelState", "string"],
      [12, "chunkCount", "uint"],
      [13, "totalAnsiBytes", "uint"],
      [14, "pendingEscapeTail", "bytes"],
      [15, "sha256", "bytes"],
      [16, "trimmedRows", "uint"],
      [17, "errorMessage", "string"],
    ],
  ],
  [
    82,
    "ptyScreenSnapshotChunk",
    [
      [1, "requestId", "string"],
      [2, "index", "uint"],
      [3, "last", "bool"],
      [4, "bytes", "bytes"],
    ],
  ],
  [
    83,
    "ptyActivity",
    [
      [1, "ptyId", "string"],
      [2, "idleBusy", "bool"],
      [3, "pressureBusy", "bool"],
      [4, "sidebarBusy", "bool"],
      [5, "reasons", "strings"],
      [6, "lastInputMs", "uint"],
      [7, "lastOutputMs", "uint"],
      [8, "quietSinceMs", "uint"],
    ],
  ],
  [84, "ptyLifecycleNotice", NOTICE],
  [
    85,
    "hostPolicyUpdateRequest",
    [
      [1, "requestId", "string"],
      [2, "policy", { message: HOST_POLICY }],
    ],
  ],
  [
    86,
    "hostPolicyUpdateResponse",
    [
      [1, "requestId", "string"],
      [2, "accepted", "bool"],
      [3, "errorCode", "string"],
      [4, "errorMessage", "string"],
      [5, "effective", { message: HOST_POLICY }],
    ],
  ],
  [
    87,
    "ptyViewStateRequest",
    [
      [1, "requestId", "string"],
      [2, "ptyId", "string"],
      [3, "viewState", "string"],
      [4, "rendererAttached", "bool"],
      [5, "ownerBusyHint", "string"],
      [6, "themeFg", "string"],
      [7, "themeBg", "string"],
      [8, "ackedSequence", "uint"],
    ],
  ],
  [88, "ptyViewStateResponse", CONTROL_RESPONSE],
  [
    89,
    "ptyKeepOpenRequest",
    [
      [1, "requestId", "string"],
      [2, "ptyId", "string"],
    ],
  ],
  [90, "ptyKeepOpenResponse", CONTROL_RESPONSE],
  [
    91,
    "ptyCloseAllRequest",
    [
      [1, "requestId", "string"],
      [2, "reason", "string"],
      [3, "managedOnly", "bool"],
    ],
  ],
  [
    92,
    "ptyCloseAllResponse",
    [
      [1, "requestId", "string"],
      [2, "accepted", "bool"],
      [3, "errorCode", "string"],
      [4, "errorMessage", "string"],
      [5, "closedCount", "uint"],
    ],
  ],
  [
    93,
    "hostResourceReport",
    [
      [1, "sampledAtMs", "uint"],
      [2, "memoryLevel", "string"],
      [3, "memoryAvailableBytes", "uint"],
      [4, "memoryTotalBytes", "uint"],
      [5, "hostRssBytes", "uint"],
      [6, "terminalRssBytes", "uint"],
      [7, "screenModelBytes", "uint"],
      [8, "spoolBytes", "uint"],
      [9, "livePtys", "uint"],
      [10, "managedLivePtys", "uint"],
      [11, "maxLivePtys", "uint"],
    ],
  ],
  [
    94,
    "hostNoticeReplayRequest",
    [
      [1, "requestId", "string"],
      [2, "expectedEpoch", "string"],
      [3, "afterNoticeId", "uint"],
    ],
  ],
  [
    95,
    "hostNoticeReplayResponse",
    [
      [1, "requestId", "string"],
      [2, "agentEpoch", "string"],
      [3, "accepted", "bool"],
      [4, "errorCode", "string"],
      [5, "notices", { repeated: NOTICE }],
      [6, "gap", "bool"],
    ],
  ],
];

export function encodePtyLifecycleFrame(
  frame: RemoteAgentFrame,
): { readonly field: number; readonly value: Uint8Array } | undefined {
  return encodeTableFrame(FRAMES, frame);
}

export function decodePtyLifecycleFrame(
  field: number,
  bytes: Uint8Array,
): RemoteAgentFrame | undefined {
  return decodeTableFrame(FRAMES, field, bytes) as RemoteAgentFrame | undefined;
}

/** Merges the 1.9 additive fields of PTY create and inventory frames decoded by legacy codecs. */
export function withPtyLifecycleFields(
  frame: RemoteAgentFrame | undefined,
  bytes: Uint8Array,
): RemoteAgentFrame | undefined {
  if (frame?.type === "ptyCreateRequest") {
    const fields = decodeTableExtension(PTY_CREATE_REQUEST_LIFECYCLE_FIELDS, bytes);
    return { type: frame.type, value: { ...frame.value, ...fields } };
  }
  if (frame?.type === "ptyCreateResponse") {
    const fields = decodeTableExtension(PTY_CREATE_RESPONSE_LIMIT_FIELDS, bytes);
    return { type: frame.type, value: { ...frame.value, ...fields } };
  }
  if (frame?.type === "ptyListResponse") {
    const entryBytes: Uint8Array[] = [];
    decodeMessage(bytes, (field, wireType, reader) => {
      if (field === 3 && wireType === 2) entryBytes.push(reader.bytesValue());
      else reader.skip(wireType);
    });
    const entries = frame.value.entries.map((entry, index) => ({
      ...entry,
      ...decodeTableExtension(PTY_INVENTORY_LIFECYCLE_FIELDS, entryBytes[index]!),
    }));
    return { type: frame.type, value: { ...frame.value, entries } };
  }
  return frame;
}
