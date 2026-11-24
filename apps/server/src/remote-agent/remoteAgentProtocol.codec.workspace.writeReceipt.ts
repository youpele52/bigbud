import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import type { RemoteAgentWriteReceiptFrame } from "./remoteAgentProtocol.writeReceipt.ts";
import {
  decodeTableFrame,
  encodeTableFrame,
  type TableFrames,
} from "./remoteAgentProtocol.codec.table.ts";

type FrameType = RemoteAgentWriteReceiptFrame["type"];

/** Field tables mirror `WriteReceiptRequest`/`WriteReceiptResponse` in `workspace.proto`. */
const FRAMES: TableFrames<FrameType> = [
  [
    108,
    "writeReceiptRequest",
    [
      [1, "requestId", "string"],
      [2, "operationId", "string"],
      [3, "requestDigest", "bytes"],
    ],
  ],
  [
    109,
    "writeReceiptResponse",
    [
      [1, "requestId", "string"],
      [2, "operationId", "string"],
      [3, "applied", "bool"],
      [4, "resultSha256", "string"],
      [5, "errorCode", "string"],
      [6, "errorMessage", "string"],
    ],
  ],
];

export function encodeWriteReceiptFrame(
  frame: RemoteAgentFrame,
): { readonly field: number; readonly value: Uint8Array } | undefined {
  return encodeTableFrame(FRAMES, frame);
}

export function decodeWriteReceiptFrame(
  field: number,
  bytes: Uint8Array,
): RemoteAgentFrame | undefined {
  return decodeTableFrame(FRAMES, field, bytes) as RemoteAgentWriteReceiptFrame | undefined;
}
