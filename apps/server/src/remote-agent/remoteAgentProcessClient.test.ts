import { describe, expect, it } from "vitest";

import { RemoteAgentProcessClient } from "./remoteAgentProcessClient.ts";
import { RemoteAgentConnectionError } from "./remoteAgentConnection.ts";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";

function fakeConnection(frames: ReadonlyArray<RemoteAgentFrame>): RemoteAgentConnection {
  const queued = [...frames];
  return {
    request: async () => queued.shift()!,
    nextFrame: async () => queued.shift()!,
    send: async () => undefined,
  } as unknown as RemoteAgentConnection;
}

const accepted: RemoteAgentFrame = {
  type: "processAccepted",
  value: {
    requestId: "request",
    operationId: "operation",
    accepted: true,
    duplicate: false,
    errorCode: "",
    errorMessage: "",
  },
};

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

describe("remote agent process client", () => {
  it("does not reconnect when transport fails before acceptance", async () => {
    let reconnects = 0;
    const client = new RemoteAgentProcessClient(
      {
        request: async () => {
          throw new RemoteAgentConnectionError("socket closed before acceptance");
        },
      } as unknown as RemoteAgentConnection,
      async () => {
        reconnects += 1;
        return new RemoteAgentProcessClient(fakeConnection([]));
      },
    );

    await expect(
      client.run({
        workspaceHandle: "workspace",
        operationId: "operation",
        requestDigest: new Uint8Array([1]),
        command: "printf",
      }),
    ).rejects.toThrow("before acceptance");
    expect(reconnects).toBe(0);
  });

  it("deduplicates retransmitted output sequences", async () => {
    const client = new RemoteAgentProcessClient(
      fakeConnection([accepted, output(1, "once"), output(1, "once"), completed]),
    );
    const result = await client.run({
      workspaceHandle: "workspace",
      operationId: "operation",
      requestDigest: new Uint8Array([1]),
      command: "printf",
    });
    expect(new TextDecoder().decode(result.stdout)).toBe("once");
  });

  it("rejects a missing output sequence", async () => {
    const client = new RemoteAgentProcessClient(fakeConnection([accepted, output(2, "gap")]));
    await expect(
      client.run({
        workspaceHandle: "workspace",
        operationId: "operation",
        requestDigest: new Uint8Array([1]),
        command: "printf",
      }),
    ).rejects.toThrow("Expected process output sequence 1");
  });

  it("accepts an attach status before replay and completion", async () => {
    const client = new RemoteAgentProcessClient(
      fakeConnection([
        {
          type: "processAttachResponse",
          value: {
            requestId: "attach",
            operationId: "operation",
            state: "running",
            nextSequence: 2,
            firstRetainedSequence: 1,
          },
        },
        output(1, "attached"),
        completed,
      ]),
    );
    const result = await client.attach({ operationId: "operation" });
    expect(new TextDecoder().decode(result.stdout)).toBe("attached");
  });

  it("reattaches after acceptance without rerunning the process", async () => {
    let attachSent = false;
    const replacementBase = fakeConnection([
      {
        type: "processAttachResponse",
        value: {
          requestId: "request:attach:1",
          operationId: "operation",
          state: "running",
          nextSequence: 1,
          firstRetainedSequence: 1,
        },
      },
      output(1, "resumed"),
      completed,
    ]);
    const replacementConnection = {
      ...replacementBase,
      send: async (frame: RemoteAgentFrame) => {
        if (frame.type === "processAttachRequest") attachSent = true;
      },
    } as unknown as RemoteAgentConnection;
    const replacement = new RemoteAgentProcessClient(replacementConnection);
    const first = {
      request: async () => accepted,
      nextFrame: async () => {
        throw new Error("socket closed");
      },
      send: async () => undefined,
    } as unknown as RemoteAgentConnection;
    const client = new RemoteAgentProcessClient(first, async () => replacement);

    const result = await client.run({
      workspaceHandle: "workspace",
      operationId: "operation",
      requestDigest: new Uint8Array([1]),
      command: "printf",
    });

    expect(attachSent).toBe(true);
    expect(new TextDecoder().decode(result.stdout)).toBe("resumed");
  });

  it("reattaches after transport loss while acknowledging output", async () => {
    let firstAck = true;
    const replacement = new RemoteAgentProcessClient(
      fakeConnection([
        {
          type: "processAttachResponse",
          value: {
            requestId: "attach",
            operationId: "operation",
            state: "running",
            nextSequence: 3,
            firstRetainedSequence: 2,
          },
        },
        output(2, "second"),
        completed,
      ]),
    );
    const first = {
      request: async () => accepted,
      nextFrame: async () => output(1, "first"),
      send: async (frame: RemoteAgentFrame) => {
        if (frame.type === "processOutputAck" && firstAck) {
          firstAck = false;
          throw new RemoteAgentConnectionError("socket closed during acknowledgement");
        }
      },
    } as unknown as RemoteAgentConnection;
    const client = new RemoteAgentProcessClient(first, async () => replacement);

    const result = await client.run({
      workspaceHandle: "workspace",
      operationId: "operation",
      requestDigest: new Uint8Array([1]),
      command: "printf",
    });

    expect(new TextDecoder().decode(result.stdout)).toBe("firstsecond");
  });

  it("sends cancellation through the typed process client", async () => {
    const client = new RemoteAgentProcessClient(
      fakeConnection([
        {
          type: "cancelResponse",
          value: {
            requestId: "cancel",
            operationId: "operation",
            cancelled: true,
            terminal: false,
            detail: "cancellation-requested",
          },
        },
      ]),
    );
    await expect(
      client.cancel({ operationId: "operation", requestId: "cancel" }),
    ).resolves.toMatchObject({
      cancelled: true,
      detail: "cancellation-requested",
    });
  });

  it("waits for the terminal cancellation state after acceptance", async () => {
    let completed = false;
    let releaseCompletion: (() => void) | undefined;
    const connection = {
      request: async (frame: RemoteAgentFrame) => {
        if (frame.type === "processRequest") return accepted;
        if (frame.type === "cancelRequest") {
          return {
            type: "cancelResponse",
            value: {
              requestId: frame.value.requestId,
              operationId: "operation",
              cancelled: true,
              terminal: false,
              detail: "cancellation-requested",
            },
          } satisfies RemoteAgentFrame;
        }
        throw new Error("unexpected request");
      },
      nextFrame: async () => {
        await new Promise<void>((resolve) => {
          releaseCompletion = resolve;
        });
        completed = true;
        return {
          type: "processCompleted",
          value: {
            requestId: "request",
            operationId: "operation",
            state: "cancelled",
            hasExitCode: false,
            exitCode: 0,
            outputTruncated: false,
            errorCode: "CANCELLED",
            errorMessage: "cancelled",
          },
        } satisfies RemoteAgentFrame;
      },
      send: async () => undefined,
    } as unknown as RemoteAgentConnection;
    const client = new RemoteAgentProcessClient(connection);
    const run = client.run({
      workspaceHandle: "workspace",
      operationId: "operation",
      requestDigest: new Uint8Array([1]),
      command: "sleep",
    });
    await Promise.resolve();
    const cancellation = client.cancelAndWait({ operationId: "operation" });
    await Promise.resolve();
    releaseCompletion?.();
    await expect(cancellation).resolves.toMatchObject({
      cancelled: true,
      terminal: true,
    });
    await expect(run).rejects.toMatchObject({ code: "CANCELLED" });
    expect(completed).toBe(true);
  });

  it("demultiplexes concurrent process streams by operation ID", async () => {
    const frames: RemoteAgentFrame[] = [
      outputFor("operation-b", 1, "b"),
      outputFor("operation-a", 1, "a"),
      completedFor("operation-b"),
      completedFor("operation-a"),
    ];
    const connection = {
      request: async (frame: RemoteAgentFrame) => {
        if (frame.type !== "processRequest") throw new Error("unexpected request");
        return {
          type: "processAccepted",
          value: {
            requestId: frame.value.requestId,
            operationId: frame.value.operationId,
            accepted: true,
            duplicate: false,
            errorCode: "",
            errorMessage: "",
          },
        } satisfies RemoteAgentFrame;
      },
      nextFrame: async (matches: (frame: RemoteAgentFrame) => boolean) => {
        const index = frames.findIndex(matches);
        if (index < 0) throw new Error("no matching frame");
        return frames.splice(index, 1)[0]!;
      },
      send: async () => undefined,
    } as unknown as RemoteAgentConnection;
    const client = new RemoteAgentProcessClient(connection);
    const [first, second] = await Promise.all([
      client.run({
        workspaceHandle: "workspace",
        operationId: "operation-a",
        requestDigest: new Uint8Array([1]),
        command: "printf",
      }),
      client.run({
        workspaceHandle: "workspace",
        operationId: "operation-b",
        requestDigest: new Uint8Array([2]),
        command: "printf",
      }),
    ]);
    expect(new TextDecoder().decode(first.stdout)).toBe("a");
    expect(new TextDecoder().decode(second.stdout)).toBe("b");
  });
});

function outputFor(operationId: string, sequence: number, text: string): RemoteAgentFrame {
  return {
    type: "processOutput",
    value: {
      operationId,
      sequence,
      stream: "stdout",
      bytes: new TextEncoder().encode(text),
    },
  };
}

function completedFor(operationId: string): RemoteAgentFrame {
  return {
    type: "processCompleted",
    value: {
      requestId: `request-${operationId}`,
      operationId,
      state: "completed",
      hasExitCode: true,
      exitCode: 0,
      outputTruncated: false,
      errorCode: "",
      errorMessage: "",
    },
  };
}
