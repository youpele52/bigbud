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

export const searchGoldenFrames: ReadonlyArray<readonly [string, RemoteAgentFrame]> = [
  [
    "workspace_search_request",
    {
      type: "workspaceSearchRequest",
      value: {
        requestId: "search-1",
        operationId: "op-1",
        roots: [
          { rootId: "project-a", root: "/home/dev/app", relativePath: "" },
          { rootId: "project-b", root: "/home/dev/lib", relativePath: "src" },
        ],
        query: "needle",
        mode: 3,
        maxResults: 200,
        maxResultsPerRoot: 20,
        deadlineMs: 3_000,
        maxThreads: 2,
        priority: 2,
      },
    },
  ],
  [
    "workspace_search_batch",
    {
      type: "workspaceSearchBatch",
      value: {
        requestId: "search-1",
        operationId: "op-1",
        sequence: 1,
        names: [
          {
            rootId: "project-a",
            path: "src/needle.ts",
            isDirectory: false,
            sizeBytes: 1_024,
            modifiedUnixMs: 1_763_500_000_000,
            score: 2,
          },
        ],
        contents: [
          {
            rootId: "project-a",
            path: "src/a.ts",
            line: 12,
            column: 5,
            excerpt: "const needle = 1;",
          },
        ],
      },
    },
  ],
  [
    "workspace_search_completed",
    {
      type: "workspaceSearchCompleted",
      value: {
        requestId: "search-1",
        operationId: "op-1",
        stopReason: "deadline",
        truncated: true,
        filesScanned: 14_421,
        rootErrors: [{ rootId: "project-b", errorCode: "NOT_FOUND" }],
        errorCode: "",
        errorMessage: "",
        batches: 3,
      },
    },
  ],
];

describe("remote agent search frames", () => {
  it("round-trips every search frame", () => {
    for (const [, frame] of searchGoldenFrames) {
      expect(decodeDelimitedFrame(encodeDelimitedFrame(frame))).toEqual(frame);
    }
  });

  it("matches the Rust protobuf golden frames", () => {
    for (const [name, frame] of searchGoldenFrames) {
      expect(goldenFrames[name], name).toBeDefined();
      expect(encodeDelimitedFrame(frame)).toEqual(goldenFrames[name]);
      expect(decodeDelimitedFrame(goldenFrames[name]!)).toEqual(frame);
    }
  });

  it("keeps an all-default repeated element instead of dropping it", () => {
    const frame: RemoteAgentFrame = {
      type: "workspaceSearchCompleted",
      value: {
        requestId: "",
        operationId: "op-2",
        stopReason: "complete",
        truncated: false,
        filesScanned: 0,
        rootErrors: [{ rootId: "", errorCode: "" }],
        errorCode: "",
        errorMessage: "",
        batches: 0,
      },
    };
    expect(decodeDelimitedFrame(encodeDelimitedFrame(frame))).toEqual(frame);
  });
});
