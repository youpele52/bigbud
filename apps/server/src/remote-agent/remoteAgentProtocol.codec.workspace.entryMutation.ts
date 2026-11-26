import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import type { RemoteAgentEntryMutationFrame } from "./remoteAgentProtocol.entryMutation.ts";
import {
  decodeTableFrame,
  encodeTableFrame,
  type TableFrames,
} from "./remoteAgentProtocol.codec.table.ts";

type FrameType = RemoteAgentEntryMutationFrame["type"];

const RESPONSE_FIELDS = [
  [1, "requestId", "string"],
  [2, "operationId", "string"],
  [3, "terminal", "bool"],
  [4, "errorCode", "string"],
  [5, "errorMessage", "string"],
] as const;

/** Field tables mirror the create-directory and delete-entry messages in `workspace.proto`. */
const FRAMES: TableFrames<FrameType> = [
  [
    110,
    "createDirectoryRequest",
    [
      [1, "requestId", "string"],
      [2, "operationId", "string"],
      [3, "requestDigest", "bytes"],
      [4, "workspaceHandle", "string"],
      [5, "path", "string"],
    ],
  ],
  [111, "createDirectoryResponse", RESPONSE_FIELDS],
  [
    112,
    "deleteEntryRequest",
    [
      [1, "requestId", "string"],
      [2, "operationId", "string"],
      [3, "requestDigest", "bytes"],
      [4, "workspaceHandle", "string"],
      [5, "path", "string"],
      [6, "expectedKind", "string"],
    ],
  ],
  [113, "deleteEntryResponse", [...RESPONSE_FIELDS, [6, "deletedKind", "string"]]],
];

export function encodeEntryMutationFrame(
  frame: RemoteAgentFrame,
): { readonly field: number; readonly value: Uint8Array } | undefined {
  return encodeTableFrame(FRAMES, frame);
}

export function decodeEntryMutationFrame(
  field: number,
  bytes: Uint8Array,
): RemoteAgentFrame | undefined {
  return decodeTableFrame(FRAMES, field, bytes) as RemoteAgentEntryMutationFrame | undefined;
}
