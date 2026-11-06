import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RemoteAgentConnection, RemoteAgentConnectionError } from "./remoteAgentConnection.ts";
import { RemoteAgentConnectionPool } from "./remoteAgentConnectionPool.ts";
import {
  assertSshTargetConnected,
  clearSshTargetDisconnected,
  configureSshTargetDisconnects,
  markSshTargetDisconnected,
  REMOTE_TARGET_DISCONNECTED_CODE,
  REMOTE_TARGET_DISCONNECTED_MESSAGE,
  RemoteTargetDisconnectedError,
} from "../ssh/sshTargetDisconnects.ts";

const target = "ssh:host=box&transport=agent";
const otherTarget = "ssh:host=other&transport=agent";

afterEach(() => configureSshTargetDisconnects(undefined, []));

function fakeChild() {
  const stdin = Object.assign(new EventEmitter(), { write: () => true, end: vi.fn() });
  return Object.assign(new EventEmitter(), {
    stdin,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(() => true),
  });
}

const hello = () => ({
  protocolMajor: 1,
  protocolMinor: 0,
  agentVersion: "0.1.0",
  buildDigest: "development",
  os: "linux",
  architecture: "x86_64",
  agentInstanceId: "agent-1",
  agentEpoch: "epoch-1",
  capabilities: ["workspace.files", "workspace.search"].map((name) => ({
    name,
    major: 1,
    minor: 0,
  })),
  maxFrameBytes: 1024,
  maxOperationOutputBytes: 1024,
  maxJournalBytes: 1024,
});

/**
 * A pool connection double that keeps failure listeners like the real connection. With
 * `handshakeGate`, the handshake waits for it, and a disconnect fails it like a real link.
 */
function pooledConnection(handshakeGate?: Promise<void>) {
  const listeners = new Set<(error: Error) => void>();
  const { promise: failed, reject: failHandshake } = Promise.withResolvers<never>();
  failed.catch(() => undefined);
  const connection = {
    handshake: async () => {
      if (handshakeGate) await Promise.race([handshakeGate, failed]);
      return hello();
    },
    onFailure: (listener: (error: Error) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    disconnect: vi.fn((error: Error) => {
      failHandshake(error);
      for (const listener of listeners) listener(error);
    }),
    close: vi.fn(),
  };
  return connection;
}

describe("RemoteAgentConnection.disconnect", () => {
  it("notifies failure listeners and waiters with the disconnect code, then closes", async () => {
    const child = fakeChild();
    const Connection = RemoteAgentConnection as unknown as new (
      child: unknown,
      maxFrameBytes: number,
    ) => RemoteAgentConnection;
    const connection = new Connection(child, 1_024);
    const failure = vi.fn();
    connection.onFailure(failure);
    const pending = connection.nextFrame();

    connection.disconnect(new RemoteTargetDisconnectedError(target));

    const expected = {
      _tag: "RemoteAgentConnectionError",
      message: REMOTE_TARGET_DISCONNECTED_MESSAGE,
      code: REMOTE_TARGET_DISCONNECTED_CODE,
    };
    await expect(pending).rejects.toMatchObject(expected);
    expect(failure).toHaveBeenCalledOnce();
    expect(failure.mock.calls[0]![0]).toBeInstanceOf(RemoteAgentConnectionError);
    expect(failure.mock.calls[0]![0]).toMatchObject(expected);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});

describe("RemoteAgentConnectionPool disconnect", () => {
  it("fails live connections through consumers and refuses reconnects until Connect", async () => {
    const created: Array<ReturnType<typeof pooledConnection>> = [];
    const pool = new RemoteAgentConnectionPool({
      create: async () => {
        const connection = pooledConnection();
        created.push(connection);
        return connection as unknown as RemoteAgentConnection;
      },
    });
    const client = await pool.getWorkspaceClient(target);
    await pool.get(otherTarget);
    const consumerFailure = vi.fn();
    created[0]!.onFailure(consumerFailure);

    await markSshTargetDisconnected(target);
    const error = new RemoteTargetDisconnectedError(target);
    pool.disconnect(target, error);

    expect(created[0]!.disconnect).toHaveBeenCalledWith(error);
    expect(consumerFailure).toHaveBeenCalledWith(error);
    expect(created[1]!.disconnect).not.toHaveBeenCalled();
    expect(pool.snapshot(target)).toMatchObject({ state: "reconnecting", agentEpoch: "epoch-1" });
    await expect(pool.get(target)).rejects.toBeInstanceOf(RemoteTargetDisconnectedError);
    await expect(
      pool.getBound(target, {
        runtime: {} as never,
        expectedEpoch: "epoch-1",
      }),
    ).rejects.toBeInstanceOf(RemoteTargetDisconnectedError);
    // Reconnect closures held by existing clients reacquire through the same guard.
    await expect(client.reconnect!()).rejects.toBeInstanceOf(RemoteTargetDisconnectedError);
    expect(created).toHaveLength(2);
    await expect(pool.get(otherTarget)).resolves.toBe(created[1]);

    await clearSshTargetDisconnected(target);
    await expect(client.reconnect!()).resolves.toBeDefined();
    expect(created).toHaveLength(3);
    expect(pool.snapshot(target)).toMatchObject({ state: "ready", agentEpoch: "epoch-1" });
  });

  it("recovers after a disconnect that interrupted connection setup", async () => {
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => (releaseCreate = resolve));
    const created: Array<ReturnType<typeof pooledConnection>> = [];
    let creates = 0;
    const pool = new RemoteAgentConnectionPool({
      create: async () => {
        creates += 1;
        if (creates === 1) await createGate;
        // Like RemoteAgentConnection.ssh: the readiness guard runs before spawning.
        assertSshTargetConnected(target);
        const connection = pooledConnection();
        created.push(connection);
        return connection as unknown as RemoteAgentConnection;
      },
    });

    const inFlight = pool.get(target);
    await markSshTargetDisconnected(target);
    pool.disconnect(target, new RemoteTargetDisconnectedError(target));
    releaseCreate();
    await expect(inFlight).rejects.toBeInstanceOf(RemoteTargetDisconnectedError);

    await clearSshTargetDisconnected(target);
    const reconnected = await pool.get(target);
    expect(reconnected).toBe(created[0]);
    expect(creates).toBe(2);
    expect(created[0]!.close).not.toHaveBeenCalled();
  });

  it("ends a connection that is still in handshake when the target disconnects", async () => {
    const created: Array<ReturnType<typeof pooledConnection>> = [];
    const pool = new RemoteAgentConnectionPool({
      create: async () => {
        assertSshTargetConnected(target);
        const connection = pooledConnection(
          created.length === 0 ? new Promise(() => {}) : undefined,
        );
        created.push(connection);
        return connection as unknown as RemoteAgentConnection;
      },
    });

    const inFlight = pool.get(target);
    await vi.waitFor(() => expect(created).toHaveLength(1));
    await markSshTargetDisconnected(target);
    const error = new RemoteTargetDisconnectedError(target);
    pool.disconnect(target, error);

    await expect(inFlight).rejects.toBe(error);
    expect(created[0]!.disconnect).toHaveBeenCalledWith(error);
    expect(created[0]!.close).toHaveBeenCalled();

    await clearSshTargetDisconnected(target);
    const reconnected = await pool.get(target);
    expect(reconnected).toBe(created[1]);
  });

  it("keeps the agent epoch when transport loss invalidates a completed setup", async () => {
    let releaseHandshake!: () => void;
    const handshakeGate = new Promise<void>((resolve) => (releaseHandshake = resolve));
    const created: Array<ReturnType<typeof pooledConnection>> = [];
    const pool = new RemoteAgentConnectionPool({
      create: async () => {
        const connection = pooledConnection(created.length === 1 ? handshakeGate : undefined);
        created.push(connection);
        return connection as unknown as RemoteAgentConnection;
      },
    });
    await pool.get(target);
    pool.markTransportLoss(target);

    const inFlight = pool.get(target);
    await vi.waitFor(() => expect(created).toHaveLength(2));
    pool.markTransportLoss(target);
    releaseHandshake();

    await expect(inFlight).rejects.toThrow("invalidated during connection setup");
    expect(created[1]!.close).toHaveBeenCalled();
    expect(pool.snapshot(target)).toMatchObject({ state: "reconnecting", agentEpoch: "epoch-1" });
    const reconnected = await pool.get(target);
    expect(reconnected).toBe(created[2]);
  });
});
