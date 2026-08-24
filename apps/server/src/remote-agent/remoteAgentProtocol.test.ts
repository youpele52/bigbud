import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { decodeDelimitedFrame, encodeDelimitedFrame } from "./remoteAgentProtocol.codec.ts";
import {
  REMOTE_AGENT_DEFAULT_MAX_FRAME_BYTES,
  REMOTE_AGENT_PROTOCOL_MAJOR,
  REMOTE_AGENT_PROTOCOL_MINOR,
  type RemoteAgentFrame,
} from "./remoteAgentProtocol.ts";

const clientHello: RemoteAgentFrame = {
  type: "clientHello",
  value: {
    protocolMajor: REMOTE_AGENT_PROTOCOL_MAJOR,
    protocolMinor: REMOTE_AGENT_PROTOCOL_MINOR,
    clientInstanceId: "client-1",
    connectionId: "connection-1",
    serverNonce: "nonce",
    maxFrameBytes: REMOTE_AGENT_DEFAULT_MAX_FRAME_BYTES,
  },
};

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

const goldenFrameValues: ReadonlyArray<RemoteAgentFrame> = [
  clientHello,
  {
    type: "agentHello",
    value: {
      protocolMajor: 1,
      protocolMinor: 0,
      agentVersion: "0.1.0",
      buildDigest: "development",
      os: "linux",
      architecture: "x86_64",
      agentInstanceId: "agent-1",
      agentEpoch: "epoch-1",
      capabilities: [{ name: "diagnostic", major: 1, minor: 0 }],
      maxFrameBytes: REMOTE_AGENT_DEFAULT_MAX_FRAME_BYTES,
      maxOperationOutputBytes: 0,
      maxJournalBytes: 0,
    },
  },
  {
    type: "diagnosticRequest",
    value: {
      requestId: "request-1",
      operationId: "operation-1",
      requestDigest: new Uint8Array([1, 2, 3]),
      workspaceHandle: "workspace-1",
      deadlineUnixMs: 123,
      kind: "diagnostic",
    },
  },
  {
    type: "diagnosticResponse",
    value: {
      requestId: "request-1",
      operationId: "operation-1",
      accepted: true,
      terminal: true,
      message: "agent-ready",
    },
  },
  {
    type: "cancelRequest",
    value: { requestId: "request-2", operationId: "operation-1" },
  },
  {
    type: "cancelResponse",
    value: {
      requestId: "request-2",
      operationId: "operation-1",
      cancelled: false,
      terminal: true,
      detail: "operation-already-terminal",
    },
  },
];

describe("remote agent protocol", () => {
  it("round-trips a client hello through the bounded frame codec", () => {
    const encoded = encodeDelimitedFrame(clientHello);
    expect(decodeDelimitedFrame(encoded)).toEqual(clientHello);
    expect(encoded.slice(0, 4)).toEqual(new Uint8Array([0, 0, 0, 39]));
  });

  it("matches the Rust protobuf golden frames", () => {
    const names = [
      "client_hello",
      "agent_hello",
      "diagnostic_request",
      "diagnostic_response",
      "cancel_request",
      "cancel_response",
    ];
    for (const [index, name] of names.entries()) {
      const encoded = encodeDelimitedFrame(goldenFrameValues[index]!);
      expect(encoded).toEqual(goldenFrames[name]);
      expect(decodeDelimitedFrame(goldenFrames[name]!)).toEqual(goldenFrameValues[index]);
    }
  });

  it("round-trips workspace and process operation frames", () => {
    const frames: ReadonlyArray<RemoteAgentFrame> = [
      {
        type: "readFileRequest",
        value: {
          requestId: "read-request",
          operationId: "read-operation",
          requestDigest: new Uint8Array([1, 2]),
          workspaceHandle: "workspace-1",
          path: "README.md",
          offset: 4,
          maxBytes: 128,
        },
      },
      {
        type: "filenameSearchResponse",
        value: {
          requestId: "search-response",
          operationId: "search-operation",
          terminal: true,
          entries: [{ path: "src", isDirectory: true, isFile: false, sizeBytes: 0 }],
          truncated: false,
          errorCode: "",
          errorMessage: "",
        },
      },
      {
        type: "contentSearchResponse",
        value: {
          requestId: "content-response",
          operationId: "content-operation",
          terminal: true,
          matches: [{ path: "README.md", line: 2, column: 3, excerpt: "match" }],
          truncated: false,
          errorCode: "",
          errorMessage: "",
        },
      },
      {
        type: "writeFileRequest",
        value: {
          requestId: "write-request",
          operationId: "write-operation",
          requestDigest: new Uint8Array([5, 6]),
          workspaceHandle: "workspace-1",
          path: "docs/README.md",
          bytes: new TextEncoder().encode("updated"),
          expectedSha256: "abc123",
        },
      },
      {
        type: "writeFileResponse",
        value: {
          requestId: "write-request",
          operationId: "write-operation",
          terminal: true,
          writtenBytes: 7,
          errorCode: "",
          errorMessage: "",
          currentSha256: "",
        },
      },
      {
        type: "processRequest",
        value: {
          requestId: "process-request",
          operationId: "process-operation",
          requestDigest: new Uint8Array([3, 4]),
          workspaceHandle: "workspace-1",
          command: "printf",
          args: ["hello"],
          timeoutMs: 1000,
          maxOutputBytes: 64,
          environment: [{ name: "GIT_CONFIG_NOSYSTEM", value: "1" }],
          stdin: new Uint8Array([10, 11]),
        },
      },
      {
        type: "processOutput",
        value: {
          operationId: "process-operation",
          sequence: 1,
          stream: "stdout",
          bytes: new Uint8Array([104, 105]),
        },
      },
      {
        type: "processCompleted",
        value: {
          requestId: "process-request",
          operationId: "process-operation",
          state: "completed",
          hasExitCode: true,
          exitCode: 0,
          outputTruncated: false,
          errorCode: "",
          errorMessage: "",
        },
      },
      {
        type: "processOutputAck",
        value: {
          requestId: "process-ack",
          operationId: "process-operation",
          acknowledgedSequence: 1,
        },
      },
      {
        type: "processAckResponse",
        value: {
          requestId: "process-ack",
          operationId: "process-operation",
          accepted: true,
          errorCode: "",
          errorMessage: "",
        },
      },
      {
        type: "processAttachResponse",
        value: {
          requestId: "process-attach",
          operationId: "process-operation",
          state: "running",
          nextSequence: 3,
          firstRetainedSequence: 2,
        },
      },
    ];
    for (const frame of frames) {
      expect(decodeDelimitedFrame(encodeDelimitedFrame(frame))).toEqual(frame);
    }
  });

  it("rejects oversized and truncated frames before decoding payloads", () => {
    expect(() => decodeDelimitedFrame(new Uint8Array([0, 16, 0, 0]), 8)).toThrow(
      "frame exceeds configured maximum",
    );
    expect(() => decodeDelimitedFrame(new Uint8Array([0, 0, 0]))).toThrow(
      "frame prefix is truncated",
    );
    expect(() => decodeDelimitedFrame(new Uint8Array([0, 0, 0, 2, 1]))).toThrow(
      "frame length does not match prefix",
    );
  });

  it("preserves binary request digests and unknown protobuf fields", () => {
    const request: RemoteAgentFrame = {
      type: "diagnosticRequest",
      value: {
        requestId: "request-1",
        operationId: "operation-1",
        requestDigest: new Uint8Array([0, 1, 255]),
        workspaceHandle: "workspace-1",
        deadlineUnixMs: 123,
        kind: "diagnostic",
      },
    };
    const encoded = encodeDelimitedFrame(request);
    const payload = encoded.slice(4);
    const withUnknownField = new Uint8Array(payload.length + 3);
    withUnknownField.set(payload);
    withUnknownField.set([0xe0, 0x03, 0x01], payload.length);
    const framed = new Uint8Array(withUnknownField.length + 4);
    new DataView(framed.buffer).setUint32(0, withUnknownField.length, false);
    framed.set(withUnknownField, 4);
    expect(decodeDelimitedFrame(framed)).toEqual(request);
  });
});
