import { afterEach, describe, expect, it } from "vitest";

import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { RemoteAgentConnectionPool } from "./remoteAgentConnectionPool.ts";
import {
  configureSshTargetDisconnects,
  markSshTargetDisconnected,
} from "../ssh/sshTargetDisconnects.ts";

const TARGET = "ssh:host=46.225.127.53&user=root&transport=agent";

afterEach(() => configureSshTargetDisconnects(undefined, []));

function runtime(generation: string) {
  const hash = "c".repeat(64);
  return {
    generation,
    version: "0.1.0",
    sha256: hash,
    buildDigest: "development",
    targetTriple: "x86_64-unknown-linux-gnu" as const,
    origin: "managed" as const,
    binaryPath: `/root/bin/0.1.0/${hash}/bigbud-remote-agent`,
    statePath: `/root/runtimes/${generation}`,
    socketPath: `/root/runtimes/${generation}/supervisor.sock`,
    logPath: `/root/runtimes/${generation}/supervisor.log`,
  };
}

function connection(epoch: string): RemoteAgentConnection {
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
      capabilities: [{ name: "terminal.pty", major: 1, minor: 0 }],
      maxFrameBytes: 1024,
      maxOperationOutputBytes: 1024,
      maxJournalBytes: 1024,
    }),
    close: () => undefined,
  } as unknown as RemoteAgentConnection;
}

/** A pool whose `get` resolves `selectedBinding`; `creates` counts every dial. */
function makePool(selectedBinding?: {
  runtime: ReturnType<typeof runtime>;
  expectedEpoch: string;
}) {
  const created: RemoteAgentConnection[] = [];
  const pool = new RemoteAgentConnectionPool({
    resolveBinding: async () => selectedBinding,
    create: async (_target, binding) => {
      const next = connection(binding?.expectedEpoch ?? "epoch-external");
      created.push(next);
      return next;
    },
  });
  return { pool, created };
}

describe("remote agent pool live connection", () => {
  it("finds a terminal's bound connection that `get` never selected, without dialing", async () => {
    const { pool, created } = makePool();
    const binding = { runtime: runtime("gen-old"), expectedEpoch: "epoch-1" };
    expect(pool.liveConnection(TARGET)).toBeNull();
    expect(created).toHaveLength(0);
    // Durable terminals connect through getBound with the owner's pinned runtime.
    const terminal = await pool.getBound(TARGET, binding, ["terminal.pty"]);
    expect(pool.liveConnection(TARGET)).toBe(terminal);
    expect(pool.liveConnection("ssh:host=other&transport=agent")).toBeNull();
    expect(created).toHaveLength(1);
  });

  it("prefers the selected connection and falls back to a bound one when it drops", async () => {
    const selectedBinding = { runtime: runtime("gen-new"), expectedEpoch: "epoch-2" };
    const { pool } = makePool(selectedBinding);
    const terminal = await pool.getBound(
      TARGET,
      { runtime: runtime("gen-old"), expectedEpoch: "epoch-1" },
      ["terminal.pty"],
    );
    const selected = await pool.get(TARGET);
    expect(pool.liveConnection(TARGET)).toBe(selected);
    pool.markTransportLoss(TARGET);
    expect(pool.liveConnection(TARGET)).toBe(terminal);
  });

  it("skips connections whose runtime is retiring", async () => {
    const { pool } = makePool();
    const binding = { runtime: runtime("gen-retiring"), expectedEpoch: "epoch-1" };
    await pool.getBound(TARGET, binding, ["terminal.pty"]);
    const release = await pool.beginRetirement(TARGET, "gen-retiring");
    expect(pool.liveConnection(TARGET)).toBeNull();
    release();
    expect(pool.liveConnection(TARGET)).not.toBeNull();
  });

  it("reports nothing for a target the user disconnected", async () => {
    const { pool } = makePool();
    await pool.getBound(TARGET, { runtime: runtime("gen-a"), expectedEpoch: "epoch-1" }, [
      "terminal.pty",
    ]);
    await markSshTargetDisconnected(TARGET);
    expect(pool.liveConnection(TARGET)).toBeNull();
  });

  it("ignores closed entries", async () => {
    const { pool } = makePool();
    await pool.getBound(TARGET, { runtime: runtime("gen-a"), expectedEpoch: "epoch-1" }, [
      "terminal.pty",
    ]);
    pool.close(TARGET);
    expect(pool.liveConnection(TARGET)).toBeNull();
  });
});
