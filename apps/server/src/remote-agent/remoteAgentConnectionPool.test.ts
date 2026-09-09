import { describe, expect, it, vi } from "vitest";

import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { RemoteAgentConnectionPool } from "./remoteAgentConnectionPool.ts";

function connection(
  epoch: string,
  capabilities: ReadonlyArray<string> = [],
  close = vi.fn(),
): RemoteAgentConnection {
  return {
    handshake: async () => ({
      protocolMajor: 1,
      protocolMinor: 0,
      agentVersion: "0.1.0",
      buildDigest: "development",
      os: "linux",
      architecture: "x86_64",
      agentInstanceId: "agent-1",
      agentEpoch: epoch,
      capabilities: capabilities.map((name) => ({ name, major: 1, minor: 0 })),
      maxFrameBytes: 1024,
      maxOperationOutputBytes: 1024,
      maxJournalBytes: 1024,
    }),
    close,
  } as unknown as RemoteAgentConnection;
}

describe("remote agent connection pool", () => {
  it("invalidates every alias bound to the retired runtime", async () => {
    const hash = "a".repeat(64);
    const runtime = {
      generation: "gen-1",
      version: "0.1.0",
      sha256: hash,
      buildDigest: "development",
      targetTriple: "x86_64-unknown-linux-gnu" as const,
      origin: "managed" as const,
      binaryPath: `/root/bin/0.1.0/${hash}/bigbud-remote-agent`,
      statePath: "/root/runtimes/gen-1",
      socketPath: "/root/runtimes/gen-1/supervisor.sock",
      logPath: "/root/runtimes/gen-1/supervisor.log",
    };
    const binding = { runtime, expectedEpoch: "epoch-1" };
    let creates = 0;
    const pool = new RemoteAgentConnectionPool({
      resolveBinding: async () => binding,
      create: async () => {
        creates += 1;
        return connection("epoch-1");
      },
    });
    await pool.get("ssh:alias-a");
    await pool.get("ssh:alias-b");
    pool.closeBound("ssh:alias-a", binding);
    await expect(pool.get("ssh:alias-a")).rejects.toThrow("remote-service-restarted");
    await expect(pool.get("ssh:alias-b")).rejects.toThrow("remote-service-restarted");
    expect(creates).toBe(2);
  });

  it("keeps replacement epochs in separate pool entries", async () => {
    const hash = "b".repeat(64);
    const runtime = {
      generation: "gen-epoch",
      version: "0.1.0",
      sha256: hash,
      buildDigest: "development",
      targetTriple: "x86_64-unknown-linux-gnu" as const,
      origin: "managed" as const,
      binaryPath: `/root/bin/0.1.0/${hash}/bigbud-remote-agent`,
      statePath: "/root/runtimes/gen-epoch",
      socketPath: "/root/runtimes/gen-epoch/supervisor.sock",
      logPath: "/root/runtimes/gen-epoch/supervisor.log",
    };
    let epoch = "epoch-1";
    let creates = 0;
    const pool = new RemoteAgentConnectionPool({
      resolveBinding: async () => ({ runtime, expectedEpoch: epoch }),
      create: async (_target, binding) => {
        creates += 1;
        return connection(binding?.expectedEpoch ?? "external");
      },
    });
    await pool.get("ssh:epoch");
    epoch = "epoch-2";
    await pool.get("ssh:epoch");
    expect(creates).toBe(2);
  });

  it("notifies shared-runtime consumers while leaving unrelated runtimes usable", async () => {
    const runtime = {
      generation: "shared",
      version: "0.1.0",
      sha256: "d".repeat(64),
      buildDigest: "development",
      targetTriple: "x86_64-unknown-linux-gnu" as const,
      origin: "managed" as const,
      binaryPath: "/root/runtimes/shared/agent",
      statePath: "/root/runtimes/shared",
      socketPath: "/root/runtimes/shared/supervisor.sock",
      logPath: "/root/runtimes/shared/supervisor.log",
    };
    const binding = { runtime, expectedEpoch: "old" };
    const other = { ...binding, runtime: { ...runtime, generation: "other" } };
    const pool = new RemoteAgentConnectionPool({
      resolveBinding: async (target) => (target === "shared" ? binding : other),
      create: async (_target, selected) => connection(selected?.expectedEpoch ?? "external"),
    });
    await pool.get("shared");
    await pool.get("unrelated");
    let interruptions = 0;
    pool.onRuntimeRestart(binding, () => {
      interruptions += 1;
    });
    pool.closeBound("shared", binding);
    expect(interruptions).toBe(1);
    await expect(pool.get("shared")).rejects.toThrow("remote-service-restarted");
    await expect(pool.get("unrelated")).resolves.toBeDefined();
  });

  it("requires the dedicated workspace watch capability", async () => {
    const pool = new RemoteAgentConnectionPool({
      create: async () => connection("epoch-1", ["workspace.files", "workspace.search"]),
    });
    await expect(pool.getWorkspaceWatchClient("ssh:one")).rejects.toThrow("workspace.watch");
  });

  it("single-flights connections per execution target", async () => {
    let creates = 0;
    const pool = new RemoteAgentConnectionPool({
      create: async () => {
        creates += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return connection("epoch-1");
      },
    });
    const [first, second] = await Promise.all([pool.get("ssh:one"), pool.get("ssh:one")]);
    expect(first).toBe(second);
    expect(creates).toBe(1);
  });

  it("reconnects after transport loss and preserves the epoch guard", async () => {
    let creates = 0;
    const pool = new RemoteAgentConnectionPool({
      create: async () => connection(String(++creates)),
    });
    await pool.get("ssh:one");
    pool.markTransportLoss("ssh:one");
    await expect(pool.get("ssh:one")).rejects.toThrow("epoch changed");
    expect(pool.snapshot("ssh:one").state).toBe("degraded");
  });

  it("fences a managed reconnect when the durable retirement check resolves asynchronously", async () => {
    const runtime = {
      generation: "gen-restart",
      version: "0.1.0",
      sha256: "c".repeat(64),
      buildDigest: "development",
      targetTriple: "x86_64-unknown-linux-gnu" as const,
      origin: "managed" as const,
      binaryPath: "/root/bin/agent",
      statePath: "/root/runtimes/gen-restart",
      socketPath: "/root/runtimes/gen-restart/supervisor.sock",
      logPath: "/root/runtimes/gen-restart/supervisor.log",
    };
    let retiring = false;
    const create = vi.fn(async () => connection("epoch-1"));
    const pool = new RemoteAgentConnectionPool({
      resolveBinding: async () => ({ runtime, expectedEpoch: "epoch-1" }),
      isRetiring: async () => {
        await Promise.resolve();
        return retiring;
      },
      create,
    });

    await pool.get("ssh:managed");
    pool.markTransportLoss("ssh:managed");
    retiring = true;

    await expect(pool.get("ssh:managed")).rejects.toThrow("retirement is fenced");
    expect(create).toHaveBeenCalledOnce();
  });

  it("admits a verified replacement epoch without un-fencing the old epoch", async () => {
    const runtime = {
      generation: "gen-replace",
      version: "0.1.0",
      sha256: "e".repeat(64),
      buildDigest: "development",
      targetTriple: "x86_64-unknown-linux-gnu" as const,
      origin: "managed" as const,
      binaryPath: "/root/runtimes/replace/agent",
      statePath: "/root/runtimes/replace",
      socketPath: "/root/runtimes/replace/supervisor.sock",
      logPath: "/root/runtimes/replace/supervisor.log",
    };
    const old = { runtime, expectedEpoch: "old" };
    const replacement = { runtime, expectedEpoch: "new" };
    const pool = new RemoteAgentConnectionPool({
      resolveBinding: async () => old,
      create: async (_target, binding) => connection(binding?.expectedEpoch ?? "external"),
    });
    await pool.get("ssh:replace");
    const release = await pool.beginRetirement("ssh:replace", runtime.generation);
    await expect(pool.get("ssh:replace")).rejects.toThrow("retirement is fenced");
    await expect(pool.admitReplacement("ssh:replace", replacement, old)).resolves.toBeDefined();
    release();
  });

  it("invalidates a ready connection when its transport fails", async () => {
    let notifyFailure: ((error: Error) => void) | undefined;
    let creates = 0;
    const pool = new RemoteAgentConnectionPool({
      create: async () => {
        creates += 1;
        const base = connection("epoch-1");
        return {
          ...base,
          onFailure: (listener: (error: Error) => void) => {
            notifyFailure = listener;
            return () => undefined;
          },
        } as unknown as RemoteAgentConnection;
      },
    });

    await pool.get("ssh:one");
    notifyFailure?.(new Error("socket closed"));
    expect(pool.snapshot("ssh:one").state).toBe("reconnecting");
    await pool.get("ssh:one");
    expect(creates).toBe(2);
  });

  it("closes a connection that finishes after pool shutdown", async () => {
    let release!: (value: RemoteAgentConnection) => void;
    const pending = new Promise<RemoteAgentConnection>((resolve) => {
      release = resolve;
    });
    const close = vi.fn();
    const pool = new RemoteAgentConnectionPool({
      create: async () => pending,
    });
    const connecting = pool.get("ssh:one");
    await Promise.resolve();
    pool.close("ssh:one");
    release(connection("epoch-1", [], close));
    await expect(connecting).rejects.toThrow("closed during connection setup");
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes a connection invalidated while it is connecting", async () => {
    let release!: (value: RemoteAgentConnection) => void;
    const pending = new Promise<RemoteAgentConnection>((resolve) => {
      release = resolve;
    });
    const close = vi.fn();
    const pool = new RemoteAgentConnectionPool({
      create: async () => pending,
    });
    const connecting = pool.get("ssh:one");
    await Promise.resolve();
    pool.markTransportLoss("ssh:one");
    release(connection("epoch-1", [], close));
    await expect(connecting).rejects.toThrow("invalidated during connection setup");
    expect(close).toHaveBeenCalledOnce();
  });
});
