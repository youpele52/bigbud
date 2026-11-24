import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { decodeDelimitedFrame, encodeDelimitedFrame } from "./remoteAgentProtocol.codec.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";

const goldenFrames = Object.fromEntries(
  readFileSync(
    new URL("../../../../protocol/remote-agent/v1.golden.frames", import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const [name, hex] = line.split("=", 2);
      return [name, Uint8Array.from(hex!.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)))];
    }),
);

const frames: ReadonlyArray<readonly [string, RemoteAgentFrame]> = [
  [
    "create_directory_request",
    {
      type: "createDirectoryRequest",
      value: {
        requestId: "mkdir-1",
        operationId: "entry-operation-1",
        requestDigest: new Uint8Array([1, 2]),
        workspaceHandle: "workspace-1",
        path: "src/new",
      },
    },
  ],
  [
    "create_directory_response_exists",
    {
      type: "createDirectoryResponse",
      value: {
        requestId: "mkdir-1",
        operationId: "entry-operation-1",
        terminal: true,
        errorCode: "ALREADY_EXISTS",
        errorMessage: "workspace file already exists",
      },
    },
  ],
  [
    "delete_entry_request",
    {
      type: "deleteEntryRequest",
      value: {
        requestId: "delete-1",
        operationId: "entry-operation-2",
        requestDigest: new Uint8Array([3, 4]),
        workspaceHandle: "workspace-1",
        path: "src/old",
        expectedKind: "directory",
      },
    },
  ],
  [
    "delete_entry_response_deleted",
    {
      type: "deleteEntryResponse",
      value: {
        requestId: "delete-1",
        operationId: "entry-operation-2",
        terminal: true,
        errorCode: "",
        errorMessage: "",
        deletedKind: "directory",
      },
    },
  ],
];

describe("remote agent create-folder and delete protocol", () => {
  it("matches the Rust protobuf golden frames", () => {
    for (const [name, frame] of frames) {
      expect(encodeDelimitedFrame(frame), name).toEqual(goldenFrames[name]);
      expect(decodeDelimitedFrame(goldenFrames[name]!), name).toEqual(frame);
    }
  });
});
