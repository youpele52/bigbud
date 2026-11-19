import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import type { RemoteAgentPasteStagingFrame } from "./remoteAgentProtocol.pasteStaging.ts";
import {
  decodeTableFrame,
  encodeTableFrame,
  type TableFrames,
} from "./remoteAgentProtocol.codec.table.ts";

type FrameType = RemoteAgentPasteStagingFrame["type"];

/** Field tables mirror `protocol/remote-agent/paste_staging.proto`; frame numbers are 66-73. */
const FRAMES: TableFrames<FrameType> = [
  [
    66,
    "pasteStageBeginRequest",
    [
      [1, "requestId", "string"],
      [2, "scope", "string"],
      [3, "uploadId", "string"],
      [4, "totalBytes", "uint"],
      [5, "extension", "string"],
      [6, "imageMimeType", "string"],
    ],
  ],
  [
    67,
    "pasteStageBeginResponse",
    [
      [1, "requestId", "string"],
      [2, "uploadId", "string"],
      [3, "accepted", "bool"],
      [4, "maxChunkBytes", "uint"],
      [5, "errorCode", "string"],
      [6, "errorMessage", "string"],
    ],
  ],
  [
    68,
    "pasteStageChunkRequest",
    [
      [1, "requestId", "string"],
      [2, "uploadId", "string"],
      [3, "offset", "uint"],
      [4, "data", "bytes"],
    ],
  ],
  [
    69,
    "pasteStageChunkResponse",
    [
      [1, "requestId", "string"],
      [2, "uploadId", "string"],
      [3, "receivedBytes", "uint"],
      [4, "errorCode", "string"],
      [5, "errorMessage", "string"],
    ],
  ],
  [
    70,
    "pasteStageCommitRequest",
    [
      [1, "requestId", "string"],
      [2, "uploadId", "string"],
      [3, "sha256", "bytes"],
    ],
  ],
  [
    71,
    "pasteStageCommitResponse",
    [
      [1, "requestId", "string"],
      [2, "uploadId", "string"],
      [3, "path", "string"],
      [4, "clipboard", "string"],
      [5, "errorCode", "string"],
      [6, "errorMessage", "string"],
    ],
  ],
  [
    72,
    "pasteStageDiscardRequest",
    [
      [1, "requestId", "string"],
      [2, "scope", "string"],
      [3, "uploadId", "string"],
    ],
  ],
  [
    73,
    "pasteStageDiscardResponse",
    [
      [1, "requestId", "string"],
      [2, "removed", "uint"],
      [3, "errorCode", "string"],
      [4, "errorMessage", "string"],
    ],
  ],
];

export function encodePasteStagingFrame(
  frame: RemoteAgentFrame,
): { readonly field: number; readonly value: Uint8Array } | undefined {
  return encodeTableFrame(FRAMES, frame);
}

export function decodePasteStagingFrame(
  field: number,
  bytes: Uint8Array,
): RemoteAgentFrame | undefined {
  return decodeTableFrame(FRAMES, field, bytes) as RemoteAgentPasteStagingFrame | undefined;
}
