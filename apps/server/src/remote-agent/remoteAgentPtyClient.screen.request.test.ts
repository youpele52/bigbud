import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import type { RemoteAgentPtyScreenSnapshotRequest } from "./remoteAgentProtocol.ptyLifecycle.ts";
import {
  remoteAgentScreenTiming,
  remoteAgentSnapshotsInFlight,
  requestRemoteAgentScreenSnapshot,
} from "./remoteAgentPtyClient.screen.ts";
import {
  bytesOf,
  FakeLifecycleConnection,
  snapshotFrames,
} from "./remoteAgentPtyClient.lifecycle.testUtils.ts";

const input = { attachRenderer: true };
const requestOf = (frame: RemoteAgentFrame) => frame.value as RemoteAgentPtyScreenSnapshotRequest;

/** Answers each snapshot request synchronously, in the same tick it was sent. */
function answerWith(
  connection: FakeLifecycleConnection,
  frames: (requestId: string, attempt: number) => RemoteAgentFrame[],
) {
  let attempt = 0;
  connection.onSend = (frame) => {
    if (frame.type !== "ptyScreenSnapshotRequest") return;
    for (const reply of frames(requestOf(frame).requestId, attempt++)) connection.deliver(reply);
  };
}

const refusal = (requestId: string, errorCode: string): RemoteAgentFrame => ({
  type: "ptyScreenSnapshotHeader",
  value: {
    ...(snapshotFrames(requestId, bytesOf(1), 1)[0]!.value as object),
    accepted: false,
    errorCode,
    errorMessage: `${errorCode} refusal`,
  } as never,
});

afterEach(() => {
  delete remoteAgentScreenTiming.delay;
});

describe("screen snapshot requests", () => {
  it("never sends to a host without terminal.screen and rejects UNSUPPORTED", async () => {
    const connection = new FakeLifecycleConnection(["terminal.pty"]);
    await expect(
      requestRemoteAgentScreenSnapshot(connection.asConnection, "pty-1", input),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(connection.sent).toHaveLength(0);
  });

  it("passes a host UNSUPPORTED refusal through without retrying", async () => {
    const connection = new FakeLifecycleConnection();
    answerWith(connection, (id) => [refusal(id, "UNSUPPORTED")]);
    await expect(
      requestRemoteAgentScreenSnapshot(connection.asConnection, "pty-1", input),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(connection.sent).toHaveLength(1);
  });

  it("reassembles chunks that arrive in the same tick as the header and caps the request", async () => {
    const connection = new FakeLifecycleConnection();
    const ansi = bytesOf(1000);
    answerWith(connection, (id) => snapshotFrames(id, ansi, 300));
    const snapshot = await requestRemoteAgentScreenSnapshot(
      connection.asConnection,
      "pty-1",
      input,
    );
    expect(Buffer.from(snapshot.ansi).equals(Buffer.from(ansi))).toBe(true);
    expect(connection.sentOfType("ptyScreenSnapshotRequest")[0]).toMatchObject({
      ptyId: "pty-1",
      attachRenderer: true,
      maxAnsiUnits: 1_048_576,
      maxUtf8Bytes: 3 * 1024 * 1024,
      maxScrollbackRows: 0,
    });
    expect(connection.inbox.unclaimedCount).toBe(0);
    expect(remoteAgentSnapshotsInFlight(connection.asConnection)).toBe(0);
  });

  it("rejects limits above the protocol caps before sending", async () => {
    const connection = new FakeLifecycleConnection();
    await expect(
      requestRemoteAgentScreenSnapshot(connection.asConnection, "pty-1", {
        ...input,
        maxUtf8Bytes: 3 * 1024 * 1024 + 1,
      }),
    ).rejects.toThrow(RangeError);
    expect(connection.sent).toHaveLength(0);
  });

  it("retries SNAPSHOT_BUSY after 250 ms and then succeeds", async () => {
    const delays: number[] = [];
    remoteAgentScreenTiming.delay = async (ms) => {
      delays.push(ms);
    };
    const connection = new FakeLifecycleConnection();
    answerWith(connection, (id, attempt) =>
      attempt < 2 ? [refusal(id, "SNAPSHOT_BUSY")] : snapshotFrames(id, bytesOf(10), 10),
    );
    await requestRemoteAgentScreenSnapshot(connection.asConnection, "pty-1", input);
    expect(delays).toEqual([250, 250]);
    expect(connection.sent).toHaveLength(3);
  });

  it("gives up on SNAPSHOT_BUSY after its bounded retries", async () => {
    remoteAgentScreenTiming.delay = async () => undefined;
    const connection = new FakeLifecycleConnection();
    answerWith(connection, (id) => [refusal(id, "SNAPSHOT_BUSY")]);
    await expect(
      requestRemoteAgentScreenSnapshot(connection.asConnection, "pty-1", input),
    ).rejects.toMatchObject({ code: "SNAPSHOT_BUSY" });
    expect(connection.sent).toHaveLength(9);
  });

  it("retries a corrupt transfer once, swallowing its late chunks", async () => {
    const connection = new FakeLifecycleConnection();
    answerWith(connection, (id, attempt) => {
      const frames = snapshotFrames(id, bytesOf(30), 10);
      // Attempt 0 delivers chunk 1 before chunk 0; its remaining chunks are late frames.
      return attempt === 0 ? [frames[0]!, frames[2]!, frames[1]!, frames[3]!] : frames;
    });
    const snapshot = await requestRemoteAgentScreenSnapshot(
      connection.asConnection,
      "pty-1",
      input,
    );
    expect(snapshot.ansi).toHaveLength(30);
    expect(connection.sent).toHaveLength(2);
    expect(connection.inbox.unclaimedCount).toBe(0);
  });

  it("fails after the single retry of a corrupt transfer", async () => {
    const connection = new FakeLifecycleConnection();
    answerWith(connection, (id) =>
      snapshotFrames(id, bytesOf(10), 10, { sha256: new Uint8Array(32) }),
    );
    await expect(
      requestRemoteAgentScreenSnapshot(connection.asConnection, "pty-1", input),
    ).rejects.toMatchObject({ code: "SNAPSHOT_INVALID" });
    expect(connection.sent).toHaveLength(2);
  });

  it("abandons a silent transfer after 5 s and retries once", async () => {
    const connection = new FakeLifecycleConnection();
    answerWith(connection, (id, attempt) =>
      attempt === 0 ? snapshotFrames(id, bytesOf(20), 10).slice(0, 2) : [],
    );
    const started = Date.now();
    await expect(
      requestRemoteAgentScreenSnapshot(connection.asConnection, "pty-1", input),
    ).rejects.toMatchObject({ code: "SNAPSHOT_TIMEOUT" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(9_900);
    expect(connection.sent).toHaveLength(2);
    expect(remoteAgentSnapshotsInFlight(connection.asConnection)).toBe(0);
  }, 20_000);

  it("keeps at most 2 transfers in flight per connection and refuses a full queue", async () => {
    const connection = new FakeLifecycleConnection();
    const pending: string[] = [];
    connection.onSend = (frame) => pending.push(requestOf(frame).requestId);
    const requests = Array.from({ length: 34 }, () =>
      requestRemoteAgentScreenSnapshot(connection.asConnection, "pty-1", input),
    );
    const refusedQueue = requestRemoteAgentScreenSnapshot(connection.asConnection, "pty-1", input);
    await expect(refusedQueue).rejects.toMatchObject({ code: "SNAPSHOT_BUSY" });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(remoteAgentSnapshotsInFlight(connection.asConnection)).toBe(2);
    for (let served = 0; served < requests.length; served += 1) {
      await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
      expect(remoteAgentSnapshotsInFlight(connection.asConnection)).toBeLessThanOrEqual(2);
      for (const frame of snapshotFrames(pending.shift()!, bytesOf(10), 10))
        connection.deliver(frame);
    }
    await Promise.all(requests);
    expect(connection.sent).toHaveLength(34);
    expect(remoteAgentSnapshotsInFlight(connection.asConnection)).toBe(0);
  });

  it("releases a queued waiter's place when its caller aborts", async () => {
    const connection = new FakeLifecycleConnection();
    connection.onSend = () => undefined;
    const first = requestRemoteAgentScreenSnapshot(connection.asConnection, "pty-1", input);
    const second = requestRemoteAgentScreenSnapshot(connection.asConnection, "pty-1", input);
    const controller = new AbortController();
    const queued = requestRemoteAgentScreenSnapshot(connection.asConnection, "pty-1", {
      ...input,
      signal: controller.signal,
    });
    controller.abort(new Error("caller left"));
    await expect(queued).rejects.toThrow("caller left");
    expect(remoteAgentSnapshotsInFlight(connection.asConnection)).toBe(2);
    void first.catch(() => undefined);
    void second.catch(() => undefined);
  });
});
