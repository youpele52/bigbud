import { describe, expect, it } from "vitest";

import { RemoteAgentConnectionError } from "./remoteAgentConnection.ts";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { RemoteAgentProcessClient } from "./remoteAgentProcessClient.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";

function fakeConnection(frames: ReadonlyArray<RemoteAgentFrame>): RemoteAgentConnection {
  const queued = [...frames];
  return {
    request: async () => queued.shift()!,
    nextFrame: async () => queued.shift()!,
    send: async () => undefined,
  } as unknown as RemoteAgentConnection;
}

const completed: RemoteAgentFrame = {
  type: "processCompleted",
  value: {
    requestId: "request",
    operationId: "operation",
    state: "completed",
    hasExitCode: true,
    exitCode: 0,
    outputTruncated: false,
    errorCode: "",
    errorMessage: "",
  },
};

function output(sequence: number, text: string): RemoteAgentFrame {
  return {
    type: "processOutput",
    value: {
      operationId: "operation",
      sequence,
      stream: "stdout",
      bytes: new TextEncoder().encode(text),
    },
  };
}

describe("remote agent process client pre-acceptance recovery", () => {
  it("reattaches when transport fails before the acceptance response", async () => {
    let reconnects = 0;
    const replacement = new RemoteAgentProcessClient(
      fakeConnection([
        {
          type: "processAttachResponse",
          value: {
            requestId: "attach",
            operationId: "operation",
            state: "running",
            nextSequence: 1,
            firstRetainedSequence: 1,
          },
        },
        output(1, "resumed"),
        completed,
      ]),
    );
    const client = new RemoteAgentProcessClient(
      {
        request: async () => {
          throw new RemoteAgentConnectionError("socket closed before acceptance");
        },
      } as unknown as RemoteAgentConnection,
      async () => {
        reconnects += 1;
        return replacement;
      },
    );

    await expect(
      client.run({
        workspaceHandle: "workspace",
        operationId: "operation",
        requestDigest: new Uint8Array([1]),
        command: "printf",
      }),
    ).resolves.toMatchObject({ duplicate: false });
    expect(reconnects).toBe(1);
  });

  it("resubmits the same operation identity when the agent has no acceptance record", async () => {
    const digest = new Uint8Array([1, 2, 3]);
    const processRequests: RemoteAgentFrame[] = [];
    let attachRequested = false;
    const replacementConnection = {
      send: async (frame: RemoteAgentFrame) => {
        if (frame.type === "processAttachRequest") attachRequested = true;
      },
      request: async (frame: RemoteAgentFrame) => {
        processRequests.push(frame);
        return {
          type: "processAccepted",
          value: {
            requestId: frame.type === "processRequest" ? frame.value.requestId : "unexpected",
            operationId: "operation",
            accepted: true,
            duplicate: false,
            errorCode: "",
            errorMessage: "",
          },
        } satisfies RemoteAgentFrame;
      },
      nextFrame: async () => {
        if (attachRequested) {
          attachRequested = false;
          return {
            type: "protocolError",
            value: {
              requestId: "",
              code: "PROCESS_REPLAY_ERROR",
              message: "operation is unknown or expired",
            },
          } satisfies RemoteAgentFrame;
        }
        return completed;
      },
    } as unknown as RemoteAgentConnection;
    const client = new RemoteAgentProcessClient(
      {
        request: async () => {
          throw new RemoteAgentConnectionError("socket closed before acceptance");
        },
      } as unknown as RemoteAgentConnection,
      async () => new RemoteAgentProcessClient(replacementConnection),
    );

    await client.run({
      workspaceHandle: "workspace",
      operationId: "operation",
      requestDigest: digest,
      command: "printf",
    });

    expect(processRequests).toHaveLength(1);
    expect(processRequests[0]).toMatchObject({
      type: "processRequest",
      value: { operationId: "operation", requestDigest: digest },
    });
  });
});
