import { expect, it } from "vitest";
import { decodeDelimitedFrame, encodeDelimitedFrame } from "./remoteAgentProtocol.codec.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";

it.each([" leading/file ", "tab\tname", "line\nbreak", " "])(
  "preserves %j in directory entries and watch requests",
  (path) => {
    const frames: RemoteAgentFrame[] = [
      {
        type: "listDirectoryResponse",
        value: {
          requestId: "list",
          operationId: "operation",
          terminal: true,
          entries: [{ path, isDirectory: true, isFile: false, sizeBytes: 0 }],
          errorCode: "",
          errorMessage: "",
        },
      },
      {
        type: "workspaceWatchStartRequest",
        value: {
          requestId: "watch",
          subscriptionId: "subscription",
          workspaceHandle: "workspace",
          path,
        },
      },
    ];
    for (const frame of frames) {
      expect(decodeDelimitedFrame(encodeDelimitedFrame(frame))).toEqual(frame);
    }
  },
);
