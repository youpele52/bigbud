import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import type { RemoteAgentTerminalHostFrame } from "./remoteAgentProtocol.terminalHost.ts";
import {
  decodeTableFrame,
  encodeTableFrame,
  type TableFrames,
} from "./remoteAgentProtocol.codec.table.ts";

const PANE = [
  [1, "ptyId", "string"],
  [2, "threadId", "string"],
  [3, "paneId", "string"],
  [4, "kind", "string"],
  [5, "ownerArtifactId", "string"],
  [6, "leaseId", "string"],
  [7, "canRetireSshSpawn", "bool"],
] as const;

/** Frames 128-131, additive in protocol 1.10; older decoders skip them. */
const FRAMES: TableFrames<RemoteAgentTerminalHostFrame["type"]> = [
  [
    128,
    "terminalHostInventoryRequest",
    [
      [1, "requestId", "string"],
      [2, "expectedEpoch", "string"],
      [3, "maxPanes", "uint"],
    ],
  ],
  [
    129,
    "terminalHostInventoryResponse",
    [
      [1, "requestId", "string"],
      [2, "agentEpoch", "string"],
      [3, "agentVersion", "string"],
      [4, "buildDigest", "string"],
      [5, "ownerArtifactId", "string"],
      [6, "panes", { repeated: PANE }],
      [7, "truncated", "bool"],
      [8, "sshSpawnRetirementAvailable", "bool"],
      [9, "accepted", "bool"],
      [10, "errorCode", "string"],
    ],
  ],
  [
    130,
    "terminalHostRetireSshSpawnRequest",
    [
      [1, "requestId", "string"],
      [2, "expectedEpoch", "string"],
      [3, "expectedBuildDigest", "string"],
      [4, "leaseIds", "strings"],
    ],
  ],
  [
    131,
    "terminalHostRetireSshSpawnResponse",
    [
      [1, "requestId", "string"],
      [2, "agentEpoch", "string"],
      [3, "accepted", "bool"],
      [4, "retiredLeaseIds", "strings"],
      [5, "sshSpawnRetired", "bool"],
      [6, "errorCode", "string"],
      [7, "errorMessage", "string"],
    ],
  ],
];

export function encodeTerminalHostFrame(
  frame: RemoteAgentFrame,
): { readonly field: number; readonly value: Uint8Array } | undefined {
  return encodeTableFrame(FRAMES, frame);
}

export function decodeTerminalHostFrame(
  field: number,
  bytes: Uint8Array,
): RemoteAgentFrame | undefined {
  return decodeTableFrame(FRAMES, field, bytes) as RemoteAgentFrame | undefined;
}
