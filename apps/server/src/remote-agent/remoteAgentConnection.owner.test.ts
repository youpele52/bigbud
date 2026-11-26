import { once } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeRemoteAgentComposition } from "./remoteAgentComposition.ts";
import { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type {
  RemoteAgentProxyClose,
  RemoteAgentProxyExit,
  RemoteAgentProxyLease,
  RemoteAgentProxyOwner,
} from "./remoteAgentConnection.owner.ts";
import { decodeDelimitedFrame, encodeDelimitedFrame } from "./remoteAgentProtocol.codec.ts";
import {
  REMOTE_AGENT_PROTOCOL_MAJOR,
  REMOTE_AGENT_PROTOCOL_MINOR,
  type RemoteAgentHello,
} from "./remoteAgentProtocol.ts";
import type { RemoteAgentRuntime } from "./remoteAgentRuntime.ts";

const legacy = vi.hoisted(() => ({ ready: vi.fn(), spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: legacy.spawn,
}));

const hash = "a".repeat(64);
const statePath = "/home/bigbud/.bigbud/agent/runtimes/generation-1";
const installed = {
  executionTargetId: "ssh:fixture",
  runtime: {
    generation: "generation-1",
    version: "1.0.0",
    sha256: hash,
    buildDigest: "fixture-build",
    targetTriple: "x86_64-unknown-linux-gnu",
    binaryPath: `/home/bigbud/.bigbud/agent/bin/1.0.0/${hash}/bigbud-remote-agent`,
    statePath,
    socketPath: `${statePath}/supervisor.sock`,
    logPath: `${statePath}/supervisor.log`,
    origin: "managed",
  } satisfies RemoteAgentRuntime,
};
const maxFrameBytes = 2_048;
const hello: RemoteAgentHello = {
  protocolMajor: REMOTE_AGENT_PROTOCOL_MAJOR,
  protocolMinor: REMOTE_AGENT_PROTOCOL_MINOR,
  agentVersion: installed.runtime.version,
  buildDigest: installed.runtime.buildDigest,
  os: "linux",
  architecture: "x86_64",
  agentInstanceId: "installed-1",
  agentEpoch: "epoch-1",
  capabilities: [{ name: "workspace", major: 1, minor: 0 }],
  maxFrameBytes,
  maxOperationOutputBytes: 4_096,
  maxJournalBytes: 8_192,
};

function fixture() {
  const pipes = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
  const exit = Promise.withResolvers<RemoteAgentProxyExit>();
  const confirmation = Promise.withResolvers<void>();
  const close = vi.fn<RemoteAgentProxyLease["close"]>(({ mode }) => {
    if (mode === "graceful") pipes.stdin.end();
    return confirmation.promise;
  });
  const lease: RemoteAgentProxyLease = { pipes, exit: exit.promise, close };
  const openAgentProxy = vi.fn<RemoteAgentProxyOwner["openAgentProxy"]>().mockResolvedValue(lease);
  return { pipes, exit, confirmation, close, lease, owner: { openAgentProxy } };
}

beforeEach(() => {
  legacy.ready.mockReset().mockRejectedValue(new Error("unexpected legacy readiness"));
  legacy.spawn.mockReset().mockImplementation(() => {
    throw new Error("unexpected SSH child");
  });
});

function expectNoLegacy() {
  expect(legacy.ready).not.toHaveBeenCalled();
  expect(legacy.spawn).not.toHaveBeenCalled();
}

describe("RemoteAgentConnection isolated SSH proxy", () => {
  it("negotiates on binary pipes, then reports the original exit and its stderr without retry", async () => {
    const { owner, pipes, exit, confirmation, close } = fixture();
    const connection = await RemoteAgentConnection.ssh({ ...installed, owner, maxFrameBytes });
    expect(connection.processId).toBeUndefined();
    expect(owner.openAgentProxy).toHaveBeenCalledExactlyOnceWith(installed, undefined);

    const clientBytes = once(pipes.stdin, "data");
    const negotiating = connection.handshake({ connectionId: "pipe-test" });
    const [encoded] = await clientBytes;
    expect(Buffer.isBuffer(encoded)).toBe(true);
    expect(decodeDelimitedFrame(encoded, maxFrameBytes)).toMatchObject({
      type: "clientHello",
      value: {
        protocolMajor: REMOTE_AGENT_PROTOCOL_MAJOR,
        connectionId: "pipe-test",
        maxFrameBytes,
      },
    });
    pipes.stderr.write("ignored-prefix:".repeat(500));
    const response = encodeDelimitedFrame({ type: "agentHello", value: hello }, maxFrameBytes);
    pipes.stdout.write(response.subarray(0, 3));
    pipes.stdout.write(response.subarray(3));
    await expect(negotiating).resolves.toEqual(hello);
    expect(connection.supportsCapability("workspace")).toBe(true);

    const onFailure = vi.fn();
    connection.onFailure(onFailure);
    const pending = expect(connection.nextFrame()).rejects.toThrow(
      /code=19, signal=null.*proxy refused$/s,
    );
    pipes.stderr.end("\nproxy refused");
    pipes.stdout.end();
    exit.resolve({ code: 19, signal: null });
    await pending;
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure.mock.calls[0]?.[0].message.length).toBeLessThan(4_250);
    expect(owner.openAgentProxy).toHaveBeenCalledOnce();
    expectNoLegacy();

    confirmation.resolve();
    await connection.closeConfirmed();
    expect(close).toHaveBeenCalledExactlyOnceWith({ mode: "terminate", timeoutMs: 2_000 });
  });

  it("does not fall back on owner refusal, an invalid pin, or legacy-only requests", async () => {
    const { owner } = fixture();
    const refusal = Object.assign(new Error("stale installation approval"), {
      code: "STALE_APPROVAL",
    });
    owner.openAgentProxy.mockRejectedValue(refusal);
    await expect(RemoteAgentConnection.ssh({ ...installed, owner })).rejects.toBe(refusal);
    await expect(
      RemoteAgentConnection.ssh({
        ...installed,
        owner,
        runtime: { ...installed.runtime, sha256: "unverified" },
      }),
    ).rejects.toThrow("Invalid runtime artifact hash");
    expect(owner.openAgentProxy).toHaveBeenCalledOnce();
    expectNoLegacy();

    await expect(
      RemoteAgentConnection.ssh({
        executionTargetId: installed.executionTargetId,
        binaryPath: "/legacy",
      }),
    ).rejects.toThrow("No SSH process was started");
    expect(legacy.spawn).not.toHaveBeenCalled();
  });

  it("passes an acquisition deadline to the owner, and pre-abort does not open a lease", async () => {
    const { owner } = fixture();
    const reason = new Error("cancelled before open");
    await expect(
      RemoteAgentConnection.ssh({ ...installed, owner, signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
    expect(owner.openAgentProxy).not.toHaveBeenCalled();

    owner.openAgentProxy.mockImplementation(
      (_target, signal) =>
        new Promise((_, reject) => {
          signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
        }),
    );
    await expect(
      RemoteAgentConnection.ssh({ ...installed, owner, timeoutMs: 10 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(owner.openAgentProxy).toHaveBeenCalledOnce();
    expectNoLegacy();
  });

  it("confirms teardown if successful acquisition races cancellation", async () => {
    const { owner, lease, close, confirmation } = fixture();
    const controller = new AbortController();
    const reason = new Error("cancelled during open");
    const closing = Promise.withResolvers<RemoteAgentProxyClose>();
    close.mockImplementation((request) => {
      closing.resolve(request);
      return confirmation.promise;
    });
    owner.openAgentProxy.mockImplementation(async () => {
      controller.abort(reason);
      return lease;
    });
    const result = expect(
      RemoteAgentConnection.ssh({ ...installed, owner, signal: controller.signal }),
    ).rejects.toBe(reason);
    await expect(closing.promise).resolves.toMatchObject({ mode: "terminate" });
    confirmation.resolve();
    await result;
    expect(close).toHaveBeenCalledOnce();
    expectNoLegacy();
  });

  it("distinguishes graceful EOF and proxy exit from confirmed lease teardown", async () => {
    const { owner, pipes, exit, close, confirmation } = fixture();
    const connection = await RemoteAgentConnection.ssh({ ...installed, owner });
    const eof = once(pipes.stdin, "end");
    pipes.stdin.resume();
    const finalFrame = connection.nextFrame();
    const graceful = connection.gracefulClose(500);
    await eof;
    expect(close).toHaveBeenCalledExactlyOnceWith({ mode: "graceful", timeoutMs: 500 });
    pipes.stdout.end(encodeDelimitedFrame({ type: "agentHello", value: hello }, maxFrameBytes));
    await expect(finalFrame).resolves.toEqual({ type: "agentHello", value: hello });
    exit.resolve({ code: 0, signal: null });
    await expect(connection.closeConfirmed(10)).rejects.toThrow("could not confirm lease teardown");
    confirmation.resolve();
    await graceful;
    await connection.closeConfirmed();
    expect(close).toHaveBeenCalledOnce();
    expectNoLegacy();
  });

  it("leaves the lease closable after an invalid teardown deadline", async () => {
    const { owner, close, confirmation } = fixture();
    const connection = await RemoteAgentConnection.ssh({ ...installed, owner });
    await expect(connection.gracefulClose(0)).rejects.toThrow(
      "Invalid remote agent proxy deadline",
    );
    await expect(connection.closeConfirmed(Infinity)).rejects.toThrow(
      "Invalid remote agent proxy deadline",
    );
    expect(close).not.toHaveBeenCalled();
    connection.close();
    confirmation.resolve();
    await connection.closeConfirmed();
    expect(close).toHaveBeenCalledExactlyOnceWith({ mode: "terminate", timeoutMs: 2_000 });
    expectNoLegacy();
  });

  it("does not report confirmed teardown when the owner loses the connection", async () => {
    const { owner, exit, close, confirmation } = fixture();
    const connection = await RemoteAgentConnection.ssh({ ...installed, owner });
    const loss = Object.assign(new Error("owner disconnected without status"), {
      code: "OWNER_LOST",
    });
    const pending = expect(connection.nextFrame()).rejects.toMatchObject({ code: "OWNER_LOST" });
    exit.reject(loss);
    await pending;
    connection.close();
    const result = expect(connection.closeConfirmed()).rejects.toBe(loss);
    confirmation.reject(loss);
    await result;
    expect(close).toHaveBeenCalledExactlyOnceWith({ mode: "terminate", timeoutMs: 2_000 });
    expect(owner.openAgentProxy).toHaveBeenCalledOnce();
    expectNoLegacy();
  });
});

describe("selected installed-proxy composition", () => {
  const binding = {
    runtime: installed.runtime,
    expectedEpoch: hello.agentEpoch,
    expectedInstanceId: hello.agentInstanceId,
  };

  it("rejects another target and generation before dispatch, with no fallback on owner refusal", async () => {
    const { owner } = fixture();
    const { pool } = makeRemoteAgentComposition({
      installedProxy: { ...installed, binding, owner },
    });
    try {
      await expect(pool.get("ssh:other")).rejects.toThrow("selection does not match");
      const statePath = installed.runtime.statePath.replace("generation-1", "generation-2");
      await expect(
        pool.getBound(installed.executionTargetId, {
          ...binding,
          runtime: {
            ...binding.runtime,
            generation: "generation-2",
            statePath,
            socketPath: `${statePath}/supervisor.sock`,
            logPath: `${statePath}/supervisor.log`,
          },
        }),
      ).rejects.toThrow("selection does not match");
      expect(owner.openAgentProxy).not.toHaveBeenCalled();
      const refusal = new Error("owner refused selected installation");
      owner.openAgentProxy.mockRejectedValue(refusal);
      await expect(pool.get(installed.executionTargetId)).rejects.toBe(refusal);
      expect(owner.openAgentProxy).toHaveBeenCalledOnce();
      expectNoLegacy();
    } finally {
      pool.closeAll();
    }
  });

  it("does not publish a proxy that returns a different instance in the selected epoch", async () => {
    const { owner, pipes, confirmation, close } = fixture();
    confirmation.resolve();
    const { pool } = makeRemoteAgentComposition({
      installedProxy: { ...installed, binding, owner },
    });
    pipes.stdin.once("data", () => {
      pipes.stdout.write(
        encodeDelimitedFrame({
          type: "agentHello",
          value: { ...hello, agentInstanceId: "other-instance" },
        }),
      );
    });
    try {
      await expect(pool.get(installed.executionTargetId)).rejects.toMatchObject({
        code: "IDENTITY_MISMATCH",
      });
      expect(pool.liveConnection(installed.executionTargetId)).toBeNull();
      expect(close).toHaveBeenCalledExactlyOnceWith({ mode: "terminate", timeoutMs: 2_000 });
      expectNoLegacy();
    } finally {
      pool.closeAll();
      for (const pipe of Object.values(pipes)) pipe.destroy();
    }
  });
});
