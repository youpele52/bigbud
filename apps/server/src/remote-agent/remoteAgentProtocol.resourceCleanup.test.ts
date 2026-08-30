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

const fileIdentity = { deviceOrVolume: "1", inodeOrFileId: "2", entryType: "file" } as const;
const directoryIdentity = {
  deviceOrVolume: "1",
  inodeOrFileId: "2",
  entryType: "directory",
} as const;

describe("resource cleanup protocol", () => {
  it("matches the Rust protobuf golden frames", () => {
    const frames: ReadonlyArray<readonly [string, RemoteAgentFrame]> = [
      [
        "resource_cleanup_root_bootstrap_request",
        {
          type: "resourceCleanupRootBootstrapRequest",
          value: {
            requestId: "root-request",
            platform: "linux",
            roots: [{ rootId: "0", path: "/tmp/root", identity: directoryIdentity }],
          },
        },
      ],
      [
        "resource_cleanup_root_bootstrap_response",
        {
          type: "resourceCleanupRootBootstrapResponse",
          value: {
            requestId: "root-request",
            accepted: true,
            errorCode: "",
            roots: [{ rootId: "0", rootHandle: "root-0" }],
          },
        },
      ],
      [
        "resource_cleanup_request",
        {
          type: "resourceCleanupRequest",
          value: {
            requestId: "request",
            operationId: "operation",
            pageDigest: new Uint8Array(32).fill(1),
            planDigest: new Uint8Array(32).fill(2),
            finalizeProofDigest: new Uint8Array(32).fill(3),
            authorizationDigest: new Uint8Array(32).fill(4),
            deadlineUnixMs: 123,
            platform: "linux",
            resources: [
              {
                resourceId: "resource",
                rootHandle: "root-0",
                relativePath: "target",
                quarantineName: ".bigbud-cleanup-target",
                identity: fileIdentity,
                rootIdentity: directoryIdentity,
                parentIdentity: directoryIdentity,
                action: "delete",
              },
            ],
          },
        },
      ],
      [
        "resource_cleanup_response",
        {
          type: "resourceCleanupResponse",
          value: {
            requestId: "request",
            operationId: "operation",
            results: [
              "removed",
              "already_absent",
              "resumed_and_removed",
              "identity_mismatch",
              "unsupported_entry",
              "busy",
              "permission_denied",
              "deadline_exceeded",
              "io_failure",
              "process_failure",
              "protocol_failure",
            ].map((outcome, index) => ({
              resourceId: String(index + 1),
              outcome:
                outcome as import("./remoteAgentProtocol.resourceCleanup.ts").RemoteAgentResourceCleanupOutcome,
              errorCode: "",
            })),
          },
        },
      ],
    ];
    for (const [name, frame] of frames) {
      expect(encodeDelimitedFrame(frame)).toEqual(goldenFrames[name]);
      if (frame.type.endsWith("Response")) {
        expect(decodeDelimitedFrame(goldenFrames[name]!)).toEqual(frame);
      }
    }
  });

  it("round-trips every typed resource outcome", () => {
    const outcomes = [
      "removed",
      "already_absent",
      "resumed_and_removed",
      "identity_mismatch",
      "unsupported_entry",
      "busy",
      "permission_denied",
      "deadline_exceeded",
      "io_failure",
      "process_failure",
      "protocol_failure",
    ] as const;
    const frame: RemoteAgentFrame = {
      type: "resourceCleanupResponse",
      value: {
        requestId: "request",
        operationId: "operation",
        results: outcomes.map((outcome, index) => ({
          resourceId: String(index),
          outcome,
          errorCode: "",
        })),
      },
    };
    expect(decodeDelimitedFrame(encodeDelimitedFrame(frame))).toEqual(frame);
  });

  it("round-trips cleanup keep-alive responses", () => {
    const frame: RemoteAgentFrame = {
      type: "resourceCleanupKeepAliveResponse",
      value: { requestId: "keep-alive" },
    };
    expect(decodeDelimitedFrame(encodeDelimitedFrame(frame))).toEqual(frame);
  });

  it("round-trips cleanup cancellation state", () => {
    const frame: RemoteAgentFrame = {
      type: "resourceCleanupCancelResponse",
      value: {
        requestId: "cancel",
        operationId: "operation",
        cancellationRequested: true,
        terminal: false,
      },
    };
    expect(decodeDelimitedFrame(encodeDelimitedFrame(frame))).toEqual(frame);
  });

  it("round-trips bigint-safe decimal identities without numeric conversion", () => {
    const frame: RemoteAgentFrame = {
      type: "resourceCleanupRequest",
      value: {
        requestId: "request",
        operationId: "operation",
        pageDigest: new Uint8Array(32).fill(1),
        planDigest: new Uint8Array(32).fill(2),
        finalizeProofDigest: new Uint8Array(32).fill(3),
        authorizationDigest: new Uint8Array(32).fill(4),
        deadlineUnixMs: 1,
        platform: "linux",
        resources: [
          {
            resourceId: "resource",
            rootHandle: "root",
            relativePath: "target",
            quarantineName: ".bigbud-cleanup-target",
            identity: {
              deviceOrVolume: "18446744073709551615",
              inodeOrFileId: "18446744073709551615",
              entryType: "file",
            },
            rootIdentity: { deviceOrVolume: "1", inodeOrFileId: "2", entryType: "directory" },
            parentIdentity: { deviceOrVolume: "1", inodeOrFileId: "2", entryType: "directory" },
            action: "delete",
          },
        ],
      },
    };
    expect(() => encodeDelimitedFrame(frame)).not.toThrow();
  });

  it("rejects malformed, truncated, and oversized framed input", () => {
    expect(() => decodeDelimitedFrame(new Uint8Array([0, 0, 0]))).toThrow("truncated");
    expect(() => decodeDelimitedFrame(new Uint8Array([0, 0, 0, 1]))).toThrow("length");
    expect(() => decodeDelimitedFrame(new Uint8Array([0, 0, 0, 2, 0, 0]))).toThrow("invalid");
    expect(() => decodeDelimitedFrame(new Uint8Array([0, 0, 0, 2]), 1)).toThrow("maximum");
  });
});
