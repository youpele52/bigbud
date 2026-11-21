import { describe, expect, it } from "vitest";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import { RemoteAgentPtyClient, RemoteAgentPtyProcess } from "./remoteAgentPtyClient.ts";
import { RemoteAgentPtyLimitError } from "./remoteAgentPtyClient.types.ts";
import {
  bytesOf,
  FakeLifecycleConnection,
  snapshotFrames,
} from "./remoteAgentPtyClient.lifecycle.testUtils.ts";

const requestIdOf = (frame: RemoteAgentFrame) => (frame.value as { requestId: string }).requestId;

function acknowledgeOutput(connection: FakeLifecycleConnection) {
  connection.onSend = (frame) => {
    if (frame.type === "ptyOutputAck")
      connection.deliver({
        type: "ptyOutputAckResponse",
        value: {
          requestId: requestIdOf(frame),
          ptyId: "pty-1",
          accepted: true,
          errorCode: "",
          errorMessage: "",
        },
      });
  };
}

const output = (sequence: number, bytes: Uint8Array): RemoteAgentFrame => ({
  type: "ptyOutput",
  value: { ptyId: "pty-1", sequence, bytes },
});

describe("remote PTY sequenced output", () => {
  it("reports every applied sequence, including a split UTF-8 character", () => {
    const connection = new FakeLifecycleConnection();
    acknowledgeOutput(connection);
    const process = new RemoteAgentPtyProcess(connection.asConnection, "pty-1", undefined);
    const events: Array<{ sequence: number; data: string }> = [];
    const text: string[] = [];
    process.onSequencedData((event) => events.push(event));
    process.onData((data) => text.push(data));
    const euro = new TextEncoder().encode("€");
    connection.deliver(output(1, euro.subarray(0, 2)));
    connection.deliver(output(2, euro.subarray(2)));
    connection.deliver(output(2, euro.subarray(2)));
    connection.deliver(output(4, new TextEncoder().encode("gap")));
    expect(events).toEqual([
      { sequence: 1, data: "" },
      { sequence: 2, data: "€" },
    ]);
    expect(text).toEqual(["€"]);
    process.detach();
  });

  it("requests screen copies over the PTY's current connection", async () => {
    const connection = new FakeLifecycleConnection();
    connection.onSend = (frame) => {
      if (frame.type === "ptyScreenSnapshotRequest")
        for (const reply of snapshotFrames(requestIdOf(frame), bytesOf(12), 5))
          connection.deliver(reply);
    };
    const process = new RemoteAgentPtyProcess(connection.asConnection, "pty-1", undefined);
    const snapshot = await process.screenSnapshot({ attachRenderer: true });
    expect(snapshot.ansi).toHaveLength(12);
    expect(process.lifecycle.capabilities()).toEqual({
      screen: true,
      lifecycle: true,
      spool: true,
      queryResponder: true,
      localLaunch: true,
    });
    process.detach();
    await expect(process.screenSnapshot({ attachRenderer: false })).rejects.toThrow();
  });
});

describe("remote PTY create with lifecycle fields", () => {
  function creating(response: Record<string, unknown>) {
    const connection = new FakeLifecycleConnection();
    connection.onSend = (frame) => {
      if (frame.type === "ptyCreateRequest")
        connection.deliver({
          type: "ptyCreateResponse",
          value: {
            requestId: requestIdOf(frame),
            ptyId: frame.value.ptyId,
            accepted: true,
            pid: 7,
            errorCode: "",
            errorMessage: "",
            ...response,
          },
        });
      if (frame.type === "ptyAttachRequest")
        connection.deliver({
          type: "ptyAttachResponse",
          value: {
            requestId: requestIdOf(frame),
            ptyId: frame.value.ptyId,
            state: "running",
            pid: 7,
            nextSequence: 1,
            firstRetainedSequence: 1,
            replayGap: false,
          },
        });
    };
    return connection;
  }
  const createInput = {
    ptyId: "pty-1",
    workspaceHandle: "terminal-root-0",
    cwd: "",
    shell: "/bin/zsh",
    cols: 80,
    rows: 24,
    lifecycle: { lifecycleManaged: true, localLaunch: true, evictPtyId: "old" },
  };

  it("sends the lifecycle fields and records the host's eviction", async () => {
    const connection = creating({ evictedPtyId: "old" });
    const process = await new RemoteAgentPtyClient(connection.asConnection).create(createInput);
    expect(connection.sentOfType("ptyCreateRequest")[0]).toMatchObject({
      lifecycleManaged: true,
      localLaunch: true,
      evictPtyId: "old",
    });
    expect(process.lifecycle.evictedPtyId).toBe("old");
    process.detach();
  });

  it("rejects PTY_LIMIT_REACHED with the limit and the eviction candidate", async () => {
    const connection = creating({
      accepted: false,
      errorCode: "PTY_LIMIT_REACHED",
      errorMessage: "limit reached",
      limit: 24,
      liveCount: 24,
      evictionCandidatePtyId: "oldest",
    });
    let released = 0;
    const error = await new RemoteAgentPtyClient(connection.asConnection)
      .create({
        ...createInput,
        onRejected: async () => {
          released += 1;
        },
      })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RemoteAgentPtyLimitError);
    expect(error).toMatchObject({
      code: "PTY_LIMIT_REACHED",
      limit: 24,
      liveCount: 24,
      evictionCandidatePtyId: "oldest",
    });
    expect(released).toBe(1);
    expect(connection.sentOfType("ptyAttachRequest")).toHaveLength(0);
  });
});
