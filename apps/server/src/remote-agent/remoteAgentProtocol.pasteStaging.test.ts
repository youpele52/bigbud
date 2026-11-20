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

export const pasteStagingGoldenFrames: ReadonlyArray<readonly [string, RemoteAgentFrame]> = [
  [
    "paste_stage_begin_request",
    {
      type: "pasteStageBeginRequest",
      value: {
        requestId: "begin-1",
        scope: "0123456789abcdef0123456789abcdef",
        uploadId: "0123456789abcdef",
        totalBytes: 1_048_576,
        extension: "png",
        imageMimeType: "image/png",
      },
    },
  ],
  [
    "paste_stage_chunk_request",
    {
      type: "pasteStageChunkRequest",
      value: {
        requestId: "chunk-1",
        uploadId: "0123456789abcdef",
        offset: 524_288,
        data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
      },
    },
  ],
  [
    "paste_stage_commit_response",
    {
      type: "pasteStageCommitResponse",
      value: {
        requestId: "commit-1",
        uploadId: "0123456789abcdef",
        path: "/home/dev/.bigbud/agent/paste/0123456789abcdef0123456789abcdef/paste-00.png",
        clipboard: "set",
        errorCode: "",
        errorMessage: "",
      },
    },
  ],
  [
    "paste_stage_discard_response",
    {
      type: "pasteStageDiscardResponse",
      value: { requestId: "discard-1", removed: 2, errorCode: "", errorMessage: "" },
    },
  ],
];

describe("remote agent paste staging protocol", () => {
  it("matches the Rust protobuf golden frames", () => {
    for (const [name, frame] of pasteStagingGoldenFrames) {
      expect(goldenFrames[name], name).toBeDefined();
      expect(encodeDelimitedFrame(frame)).toEqual(goldenFrames[name]);
      expect(decodeDelimitedFrame(goldenFrames[name]!)).toEqual(frame);
    }
  });

  it("decodes absent fields as protobuf defaults", () => {
    const encoded = encodeDelimitedFrame({
      type: "pasteStageBeginResponse",
      value: {
        requestId: "b",
        uploadId: "",
        accepted: false,
        maxChunkBytes: 0,
        errorCode: "UNAVAILABLE",
        errorMessage: "",
      },
    });
    expect(decodeDelimitedFrame(encoded)).toEqual({
      type: "pasteStageBeginResponse",
      value: {
        requestId: "b",
        uploadId: "",
        accepted: false,
        maxChunkBytes: 0,
        errorCode: "UNAVAILABLE",
        errorMessage: "",
      },
    });
  });
});
