import { afterEach, describe, expect, it, vi } from "vitest";

import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { RemoteAgentPtyClient, remoteAgentPtyReconnectTiming } from "./remoteAgentPtyClient.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import {
  isRemoteAgentReconnectStopFailure,
  remoteAgentReconnectDelayMs,
  runRemoteAgentReconnectEpisode,
} from "./remoteAgentReconnectPolicy.ts";

afterEach(() => {
  delete remoteAgentPtyReconnectTiming.delay;
});

describe("remote agent reconnect episodes", () => {
  it("uses jittered 1/2/4/8/16/30 second delays capped at 30 seconds", () => {
    const delays = Array.from({ length: 10 }, (_, index) =>
      remoteAgentReconnectDelayMs(index + 1, () => 0.5),
    );
    expect(delays).toEqual([0, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000]);
    expect(remoteAgentReconnectDelayMs(3, () => 0)).toBe(1_600);
    expect(remoteAgentReconnectDelayMs(3, () => 1)).toBe(2_400);
  });

  it("stops at ten attempts and immediately for authentication or host-key failures", async () => {
    const waits: number[] = [];
    const transient = vi.fn(async () => {
      throw new Error("connection reset");
    });
    const exhausted = await runRemoteAgentReconnectEpisode({
      attempt: transient,
      cancelled: () => false,
      delay: async (ms) => void waits.push(ms),
      random: () => 0.5,
    });
    expect(exhausted.status).toBe("exhausted");
    expect(transient).toHaveBeenCalledTimes(10);
    expect(waits).toHaveLength(9);
    const hostKey = vi.fn(async () => {
      throw new Error("Host key verification failed.");
    });
    expect(
      await runRemoteAgentReconnectEpisode({ attempt: hostKey, cancelled: () => false }),
    ).toMatchObject({ status: "stopped" });
    expect(hostKey).toHaveBeenCalledOnce();
    expect(isRemoteAgentReconnectStopFailure(new Error("Permission denied (publickey)."))).toBe(
      true,
    );
    expect(isRemoteAgentReconnectStopFailure(new Error("socket closed"))).toBe(false);
  });
});

describe("remote PTY reconnect", () => {
  it("reattaches after transient failures and reports a stop without further attempts", async () => {
    remoteAgentPtyReconnectTiming.delay = async () => undefined;
    let fail: ((error: Error) => void) | undefined;
    const connection = {
      onFrame: () => () => undefined,
      onFailure: (listener: (error: Error) => void) => {
        fail = listener;
        return () => undefined;
      },
      request: async (frame: RemoteAgentFrame) =>
        ({
          type: frame.type === "ptyCreateRequest" ? "ptyCreateResponse" : "ptyAttachResponse",
          value: { ptyId: "pty-1", accepted: true, pid: 5, firstRetainedSequence: 1 },
        }) as unknown as RemoteAgentFrame,
    } as unknown as RemoteAgentConnection;
    let outcomes = ["socket closed", "socket closed", null];
    const reconnect = vi.fn(async () => {
      const next = outcomes.shift();
      if (next) throw new Error(next);
      return connection;
    });
    const process = await new RemoteAgentPtyClient(connection, reconnect).create({
      ptyId: "pty-1",
      workspaceHandle: "w",
      cwd: "",
      shell: "/bin/sh",
      args: [],
      cols: 80,
      rows: 24,
    });
    const errors: string[] = [];
    process.onError((error) => errors.push((error as { code?: string }).code ?? error.message));
    fail?.(new Error("transport lost"));
    await vi.waitFor(() => expect(reconnect).toHaveBeenCalledTimes(3));
    expect(errors).toEqual([]);
    outcomes = ["Host key verification failed."];
    fail?.(new Error("transport lost"));
    await vi.waitFor(() => expect(errors).toEqual(["PTY_RECONNECT_STOPPED"]));
    expect(reconnect).toHaveBeenCalledTimes(4);
  });
});
