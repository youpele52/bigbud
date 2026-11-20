import { afterEach, expect, it, vi } from "vitest";
import type { RemoteAgentFrame } from "./remoteAgentProtocol";
import type { RemoteAgentConnection } from "./remoteAgentConnection";
import type { RemoteAgentConnectionPool } from "./remoteAgentConnectionPool";
import type { RemoteAgentOwnerStore } from "./remoteAgentOwners";
import { remoteAgentBuildId } from "./remoteAgentRuntime";
import { emptyRemoteAgentRegistry } from "./remoteAgentInstall.registry";
import { profileOwner, spawnInput } from "./remoteAgentOwnedPty.profile.testUtils";

const control = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("./remoteAgentControl.ts", () => ({
  openRemoteAgentControl: async () => ({ registry: { update: control.update } }),
}));
import { makeOwnedRemoteAgentPty } from "./remoteAgentOwnedPty";

afterEach(() => vi.restoreAllMocks());

async function fixture() {
  let owner = profileOwner();
  control.update.mockImplementation(async (change) =>
    change({
      ...emptyRemoteAgentRegistry(),
      builds: [
        {
          id: remoteAgentBuildId(owner.runtime),
          runtime: owner.runtime,
          health: "staged",
          promotion: 0,
          binary: "present",
          authenticated: true,
        },
      ],
    }),
  );
  const frames = new Set<(frame: RemoteAgentFrame) => unknown>();
  const failures = new Set<(error: Error) => void>();
  const reply = async (frame: RemoteAgentFrame): Promise<RemoteAgentFrame> => {
    if (frame.type !== "ptyAttachRequest") throw new Error("No create/input/stop allowed");
    return {
      type: "ptyAttachResponse",
      value: {
        requestId: frame.value.requestId,
        ptyId: owner.resourceId,
        pid: 42,
        state: "running",
        nextSequence: 1,
        firstRetainedSequence: 1,
        replayGap: false,
      },
    };
  };
  const request = vi.fn(reply);
  const connection = {
    request,
    close: vi.fn(),
    onFrame: (listener: (frame: RemoteAgentFrame) => unknown) => {
      frames.add(listener);
      return () => frames.delete(listener);
    },
    onFailure: (listener: (error: Error) => void) => {
      failures.add(listener);
      return () => failures.delete(listener);
    },
  } as unknown as RemoteAgentConnection;
  const pool = {
    getBound: vi.fn(async () => connection),
    onRuntimeRestart: () => () => {},
  } as unknown as RemoteAgentConnectionPool;
  const store = {
    get: async () => owner,
    update: async (_key: string, change: (value: typeof owner) => typeof owner) => {
      owner = change(owner);
      return owner;
    },
  } as unknown as RemoteAgentOwnerStore;
  const process = await makeOwnedRemoteAgentPty(pool, () => store)(spawnInput());
  request.mockClear();
  const notices: string[] = [];
  process.onData((data) => notices.push(data));
  notices.length = 0;
  return { process, request, reply, connection, owner: () => owner, frames, failures, notices };
}

it("does not certify a cached warm PID when the transport fails before its failure callback", async () => {
  const f = await fixture();
  f.request.mockRejectedValue(new Error("transport gone; failure callback not delivered"));
  try {
    await expect(f.process.reconnectRemote!()).rejects.toThrow();
    expect(f.request).toHaveBeenCalled();
    expect(f.owner().state).not.toBe("terminal");
    expect(f.connection.close).not.toHaveBeenCalled();
  } finally {
    f.process.detach!();
  }
});

it("requires a fresh same-resource receipt on every successful warm attachment", async () => {
  const f = await fixture();
  try {
    await f.process.reconnectRemote!();
    await f.process.reconnectRemote!();
    expect(f.request).toHaveBeenCalledTimes(2);
    for (const [frame] of f.request.mock.calls)
      expect(frame).toMatchObject({
        type: "ptyAttachRequest",
        value: { ptyId: f.owner().resourceId },
      });
    expect(f.process.pid).toBe(42);
  } finally {
    f.process.detach!();
  }
});

it.each([
  { state: "stopped", pid: 42 },
  { state: "outcome-unknown", pid: 42 },
  { state: "running", pid: 99 },
  { state: "running", pid: 0 },
])("refuses stale or conflicting receipt %j without changing PID/owner", async (observed) => {
  const f = await fixture();
  f.request.mockImplementation(async (frame) => {
    const response = await f.reply(frame);
    if (response.type !== "ptyAttachResponse") throw new Error("Unexpected reply");
    return { ...response, value: { ...response.value, ...observed } };
  });
  try {
    await expect(f.process.reconnectRemote!()).rejects.toThrow("not confirmed running");
    expect(f.process.pid).toBe(42);
    expect(f.owner().state).not.toBe("terminal");
    expect(f.connection.close).not.toHaveBeenCalled();
  } finally {
    f.process.detach!();
  }
});

it("does not dispatch confirmation for an already cancelled caller", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort(new Error("caller left"));
  try {
    await expect(f.process.reconnectRemote!(controller.signal)).rejects.toThrow("caller left");
    expect(f.request).not.toHaveBeenCalled();
    expect(f.connection.close).not.toHaveBeenCalled();
  } finally {
    f.process.detach!();
  }
});

it("ignores a late confirmation response after caller cancellation", async () => {
  const f = await fixture();
  const controller = new AbortController();
  let resolve!: (frame: RemoteAgentFrame) => void;
  let requested!: RemoteAgentFrame;
  f.request.mockImplementation((frame) => {
    requested = frame;
    return new Promise((done) => {
      resolve = done;
    });
  });
  const pending = f.process.reconnectRemote!(controller.signal);
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
  controller.abort(new Error("caller deadline"));
  const response = await f.reply(requested);
  if (response.type !== "ptyAttachResponse") throw new Error("Unexpected reply");
  resolve({ ...response, value: { ...response.value, pid: 99 } });
  try {
    await expect(pending).rejects.toThrow("caller deadline");
    expect(f.process.pid).toBe(42);
    expect(f.owner().state).not.toBe("terminal");
    expect(f.connection.close).not.toHaveBeenCalled();
  } finally {
    f.process.detach!();
  }
});
