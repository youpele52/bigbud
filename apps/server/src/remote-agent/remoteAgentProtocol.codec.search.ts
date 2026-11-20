import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import type { RemoteAgentSearchFrame } from "./remoteAgentProtocol.search.ts";
import {
  decodeTableFrame,
  encodeTableFrame,
  type TableFrames,
} from "./remoteAgentProtocol.codec.table.ts";

/** Field tables mirror `protocol/remote-agent/search.proto`; frame numbers are 74-79. */
const FRAMES: TableFrames<RemoteAgentSearchFrame["type"]> = [
  [
    74,
    "workspaceSearchRequest",
    [
      [1, "requestId", "string"],
      [2, "operationId", "string"],
      [
        3,
        "roots",
        {
          repeated: [
            [1, "rootId", "string"],
            [2, "root", "string"],
            [3, "relativePath", "string"],
          ],
        },
      ],
      [4, "query", "string"],
      [5, "mode", "uint"],
      [6, "maxResults", "uint"],
      [7, "maxResultsPerRoot", "uint"],
      [8, "deadlineMs", "uint"],
      [9, "maxThreads", "uint"],
      [10, "priority", "uint"],
    ],
  ],
  [
    75,
    "workspaceSearchBatch",
    [
      [1, "requestId", "string"],
      [2, "operationId", "string"],
      [3, "sequence", "uint"],
      [
        4,
        "names",
        {
          repeated: [
            [1, "rootId", "string"],
            [2, "path", "string"],
            [3, "isDirectory", "bool"],
            [4, "sizeBytes", "uint"],
            [5, "modifiedUnixMs", "uint"],
            [6, "score", "uint"],
          ],
        },
      ],
      [
        5,
        "contents",
        {
          repeated: [
            [1, "rootId", "string"],
            [2, "path", "string"],
            [3, "line", "uint"],
            [4, "column", "uint"],
            [5, "excerpt", "string"],
          ],
        },
      ],
    ],
  ],
  [
    76,
    "workspaceSearchCompleted",
    [
      [1, "requestId", "string"],
      [2, "operationId", "string"],
      [3, "stopReason", "string"],
      [4, "truncated", "bool"],
      [5, "filesScanned", "uint"],
      [
        6,
        "rootErrors",
        {
          repeated: [
            [1, "rootId", "string"],
            [2, "errorCode", "string"],
          ],
        },
      ],
      [7, "errorCode", "string"],
      [8, "errorMessage", "string"],
      [9, "batches", "uint"],
    ],
  ],
  [
    77,
    "osIndexSearchRequest",
    [
      [1, "requestId", "string"],
      [2, "operationId", "string"],
      [3, "query", "string"],
      [4, "scopeLevel", "uint"],
      [5, "maxResults", "uint"],
      [6, "deadlineMs", "uint"],
    ],
  ],
  [
    78,
    "osIndexSearchBatch",
    [
      [1, "requestId", "string"],
      [2, "operationId", "string"],
      [3, "sequence", "uint"],
      [
        4,
        "hits",
        {
          repeated: [
            [1, "path", "string"],
            [2, "isDirectory", "bool"],
            [3, "contentType", "string"],
            [4, "sizeBytes", "uint"],
            [5, "modifiedUnixMs", "uint"],
            [6, "lastUsedUnixMs", "uint"],
            [7, "score", "uint"],
          ],
        },
      ],
    ],
  ],
  [
    79,
    "osIndexSearchCompleted",
    [
      [1, "requestId", "string"],
      [2, "operationId", "string"],
      [3, "stopReason", "string"],
      [4, "truncated", "bool"],
      [5, "source", "string"],
      [6, "availability", "string"],
      [7, "excluded", "uint"],
      [8, "errorCode", "string"],
      [9, "errorMessage", "string"],
      [10, "batches", "uint"],
    ],
  ],
];

export function encodeSearchFrame(
  frame: RemoteAgentFrame,
): { readonly field: number; readonly value: Uint8Array } | undefined {
  return encodeTableFrame(FRAMES, frame);
}

export function decodeSearchFrame(field: number, bytes: Uint8Array): RemoteAgentFrame | undefined {
  return decodeTableFrame(FRAMES, field, bytes) as RemoteAgentSearchFrame | undefined;
}
