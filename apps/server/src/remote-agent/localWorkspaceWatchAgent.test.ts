import { describe, expect, it, vi } from "vitest";

import { LocalWorkspaceWatchAgent } from "./localWorkspaceWatchAgent.ts";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { RemoteAgentHello } from "./remoteAgentProtocol.ts";

function hello(
  epoch: string,
  capabilities = ["workspace.files", "workspace.watch"],
): RemoteAgentHello {
  return {
    protocolMajor: 1,
    protocolMinor: 0,
    agentVersion: "0.1.0",
    buildDigest: "development",
    os: "linux",
    architecture: "x86_64",
    agentInstanceId: `agent-${epoch}`,
    agentEpoch: epoch,
    capabilities: capabilities.map((name) => ({ name, major: 1, minor: 0 })),
    maxFrameBytes: 1024,
    maxOperationOutputBytes: 1024,
    maxJournalBytes: 0,
  };
}

function connection(epoch: string, capabilities?: ReadonlyArray<string>) {
  let failureListener: ((error: Error) => void) | undefined;
  const close = vi.fn();
  const value = {
    processId: Number(epoch),
    handshake: vi.fn(async () => hello(epoch, capabilities ? [...capabilities] : undefined)),
    onFailure: vi.fn((listener: (error: Error) => void) => {
      failureListener = listener;
      return () => {
        failureListener = undefined;
      };
    }),
    close,
  } as unknown as RemoteAgentConnection;
  return {
    value,
    close,
    fail: (error = new Error("transport lost")) => failureListener?.(error),
  };
}

describe("local workspace watcher agent", () => {
  it("shares one single-flight process across concurrent callers", async () => {
    const created = connection("1");
    const createConnection = vi.fn(() => created.value);
    const agent = new LocalWorkspaceWatchAgent({
      resolveBinary: () => "/tmp/agent",
      createConnection,
    });

    const [first, second] = await Promise.all([agent.getConnection(), agent.getConnection()]);
    expect(first).toBe(second);
    expect(createConnection).toHaveBeenCalledOnce();
    expect(agent.processId).toBe(1);
    agent.close();
    expect(created.close).toHaveBeenCalledOnce();
  });

  it("accepts a new epoch after bounded crash recovery", async () => {
    const first = connection("1");
    const second = connection("2");
    const connections = [first, second];
    const delays: number[] = [];
    const agent = new LocalWorkspaceWatchAgent({
      resolveBinary: () => "/tmp/agent",
      createConnection: () => connections.shift()!.value,
      restartDelayMs: 25,
      now: () => 100,
      wait: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    await agent.getConnection();
    first.fail();
    await agent.getConnection();
    expect(delays).toEqual([25]);
    expect(agent.agentEpoch).toBe("2");
    agent.close();
  });

  it("increases backoff across rapid successful-handshake crash loops", async () => {
    const first = connection("1");
    const second = connection("2");
    const third = connection("3");
    const connections = [first, second, third];
    const delays: number[] = [];
    const agent = new LocalWorkspaceWatchAgent({
      resolveBinary: () => "/tmp/agent",
      createConnection: () => connections.shift()!.value,
      restartDelayMs: 25,
      now: () => 100,
      wait: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    await agent.getConnection();
    first.fail();
    await agent.getConnection();
    second.fail();
    await agent.getConnection();
    expect(delays).toEqual([25, 50]);
    agent.close();
  });

  it("closes a child whose handshake is still in flight", async () => {
    let resolveHandshake: ((hello: RemoteAgentHello) => void) | undefined;
    const close = vi.fn();
    const pendingConnection = {
      handshake: vi.fn(
        () =>
          new Promise<RemoteAgentHello>((resolve) => {
            resolveHandshake = resolve;
          }),
      ),
      close,
    } as unknown as RemoteAgentConnection;
    const agent = new LocalWorkspaceWatchAgent({
      resolveBinary: () => "/tmp/agent",
      createConnection: () => pendingConnection,
    });

    const starting = agent.getConnection();
    agent.close();
    resolveHandshake?.(hello("1"));
    await expect(starting).rejects.toThrow("closed");
    expect(close).toHaveBeenCalled();
  });

  it("cancels a pending restart delay without launching another child", async () => {
    vi.useFakeTimers();
    try {
      const first = connection("1");
      const createConnection = vi.fn(() => first.value);
      const agent = new LocalWorkspaceWatchAgent({
        resolveBinary: () => "/tmp/agent",
        createConnection,
        restartDelayMs: 30_000,
      });

      await agent.getConnection();
      first.fail();
      const restarting = agent.getConnection();
      agent.close();

      await expect(restarting).rejects.toThrow("closed");
      expect(createConnection).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an agent without workspace watch capability", async () => {
    const unsupported = connection("1", ["workspace.files"]);
    const agent = new LocalWorkspaceWatchAgent({
      resolveBinary: () => "/tmp/agent",
      createConnection: () => unsupported.value,
    });

    await expect(agent.getConnection()).rejects.toThrow("workspace.watch");
    expect(unsupported.close).toHaveBeenCalledOnce();
    agent.close();
  });

  it("reports an explicit close as permanently unavailable", async () => {
    const agent = new LocalWorkspaceWatchAgent({
      resolveBinary: () => "/tmp/agent",
    });
    agent.close();

    await expect(agent.getConnection()).rejects.toMatchObject({ retryable: false });
  });
});
