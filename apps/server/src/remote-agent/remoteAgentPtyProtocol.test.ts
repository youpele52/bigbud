import { describe, expect, it } from "vitest";

import { decodeDelimitedFrame, encodeDelimitedFrame } from "./remoteAgentProtocol.codec.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";

describe("remote agent PTY protocol", () => {
  it("round-trips create, attach, and output frames", () => {
    const frames: RemoteAgentFrame[] = [
      {
        type: "ptyCreateRequest",
        value: {
          requestId: "request-1",
          ptyId: "pty-1",
          requestDigest: new Uint8Array([1, 2, 3]),
          workspaceHandle: "workspace-1",
          cwd: "",
          shell: "/bin/sh",
          args: ["-lc", "echo ok"],
          cols: 120,
          rows: 30,
          environment: [{ name: "TERM", value: "xterm-256color" }],
        },
      },
      {
        type: "ptyCreateResponse",
        value: {
          requestId: "request-1",
          ptyId: "pty-1",
          accepted: true,
          pid: 42,
          errorCode: "",
          errorMessage: "",
        },
      },
      {
        type: "ptyOutput",
        value: { ptyId: "pty-1", sequence: 1, bytes: new Uint8Array([0, 255]) },
      },
      {
        type: "ptyAttachResponse",
        value: {
          requestId: "request-2",
          ptyId: "pty-1",
          state: "running",
          pid: 42,
          nextSequence: 2,
          firstRetainedSequence: 1,
          replayGap: false,
        },
      },
      {
        type: "ptyExited",
        value: { ptyId: "pty-1", exitCode: 0, hasExitCode: true, signal: 0, hasSignal: false },
      },
    ];

    for (const frame of frames) {
      expect(decodeDelimitedFrame(encodeDelimitedFrame(frame))).toEqual(frame);
    }
  });

  it("round-trips input sequencing and control responses", () => {
    const frames: RemoteAgentFrame[] = [
      {
        type: "ptyInput",
        value: { requestId: "input-1", ptyId: "pty-1", sequence: 4, bytes: new Uint8Array([10]) },
      },
      {
        type: "ptyOutputAck",
        value: { requestId: "ack-1", ptyId: "pty-1", acknowledgedSequence: 4 },
      },
      {
        type: "ptyResizeRequest",
        value: { requestId: "resize-1", ptyId: "pty-1", cols: 100, rows: 40 },
      },
      {
        type: "ptySignalRequest",
        value: { requestId: "signal-1", ptyId: "pty-1", signal: "SIGTERM" },
      },
      {
        type: "ptyCloseRequest",
        value: { requestId: "close-1", ptyId: "pty-1", terminate: true },
      },
      {
        type: "ptyInputResponse",
        value: {
          requestId: "input-1",
          ptyId: "pty-1",
          accepted: true,
          errorCode: "",
          errorMessage: "",
        },
      },
      {
        type: "ptyOutputAckResponse",
        value: {
          requestId: "ack-1",
          ptyId: "pty-1",
          accepted: true,
          errorCode: "",
          errorMessage: "",
        },
      },
    ];

    for (const frame of frames) {
      expect(decodeDelimitedFrame(encodeDelimitedFrame(frame))).toEqual(frame);
    }
  });
});
