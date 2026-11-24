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
    "write_receipt_request",
    {
      type: "writeReceiptRequest",
      value: {
        requestId: "receipt-1",
        operationId: "write-operation-1",
        requestDigest: new Uint8Array([5, 6]),
      },
    },
  ],
  [
    "write_receipt_response_applied",
    {
      type: "writeReceiptResponse",
      value: {
        requestId: "receipt-1",
        operationId: "write-operation-1",
        applied: true,
        resultSha256: "ab".repeat(32),
        errorCode: "",
        errorMessage: "",
      },
    },
  ],
  [
    "write_receipt_response_conflict",
    {
      type: "writeReceiptResponse",
      value: {
        requestId: "receipt-2",
        operationId: "write-operation-1",
        applied: false,
        resultSha256: "",
        errorCode: "OPERATION_ID_CONFLICT",
        errorMessage: "operation id conflict",
      },
    },
  ],
];

describe("remote agent write receipt protocol", () => {
  it("matches the Rust protobuf golden frames", () => {
    for (const [name, frame] of frames) {
      expect(encodeDelimitedFrame(frame)).toEqual(goldenFrames[name]);
      expect(decodeDelimitedFrame(goldenFrames[name]!)).toEqual(frame);
    }
  });
});
