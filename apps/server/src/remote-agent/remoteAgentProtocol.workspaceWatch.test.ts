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
    "workspace_watch_start_request",
    {
      type: "workspaceWatchStartRequest",
      value: {
        requestId: "watch-start",
        subscriptionId: "watch-1",
        workspaceHandle: "workspace-1",
        path: "docs",
      },
    },
  ],
  [
    "workspace_watch_start_response",
    {
      type: "workspaceWatchStartResponse",
      value: {
        requestId: "watch-start",
        subscriptionId: "watch-1",
        accepted: true,
        generation: 4,
        backend: "native",
        errorCode: "",
        errorMessage: "",
      },
    },
  ],
  [
    "workspace_watch_event",
    {
      type: "workspaceWatchEvent",
      value: {
        subscriptionId: "watch-1",
        generation: 4,
        sequence: 2,
        changes: [{ path: "docs/README.md", kind: "modify" }],
        rescanRequired: false,
        rescanReason: "",
      },
    },
  ],
  [
    "workspace_watch_stop_request",
    {
      type: "workspaceWatchStopRequest",
      value: { requestId: "watch-stop", subscriptionId: "watch-1" },
    },
  ],
  [
    "workspace_watch_stop_response",
    {
      type: "workspaceWatchStopResponse",
      value: { requestId: "watch-stop", subscriptionId: "watch-1", stopped: true },
    },
  ],
];

describe("remote agent workspace watch protocol", () => {
  it("matches the Rust protobuf golden frames", () => {
    for (const [name, frame] of frames) {
      expect(encodeDelimitedFrame(frame)).toEqual(goldenFrames[name]);
      expect(decodeDelimitedFrame(goldenFrames[name]!)).toEqual(frame);
    }
  });
});
