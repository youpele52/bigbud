import { makeOwnedRemoteAgentPty } from "./remoteAgentOwnedPty.ts";
import type { RemoteAgentConnectionPool } from "./remoteAgentConnectionPool.ts";
import type { RemoteAgentOwnerStore } from "./remoteAgentOwners.ts";
import { spawnInput } from "./remoteAgentOwnedPty.profile.testUtils.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as NodeSqlite from "../persistence/NodeSqliteClient.ts";
import OwnersMigration from "../persistence/Migrations/111_RemoteAgentRuntimeBindings.ts";
import ReplayMigration from "../persistence/Migrations/112_RemoteAgentReplayFence.ts";
import { makeRemoteAgentRuntimeBindings } from "../persistence/Layers/RemoteAgentRuntimeBindings.ts";
import type { RemoteAgentOwner } from "./remoteAgentOwners.ts";
import { parseRemoteAgentOwner } from "./remoteAgentOwners.ts";
import { remoteAgentPtyRequestDigest } from "./remoteAgentShellLaunch.ts";
import { RemoteAgentTerminalDiscovery } from "./remoteAgentTerminalDiscovery.ts";

function owner(terminalId: string): RemoteAgentOwner {
  const sha256 = "a".repeat(64);
  return {
    ownerKey: `terminal:${JSON.stringify(["thread-1", terminalId])}`,
    target: "ssh:host",
    connectionId: "connection-1",
    runtime: {
      generation: "g1",
      version: "0.2.207",
      sha256,
      buildDigest: "fixture",
      targetTriple: "aarch64-unknown-linux-gnu",
      origin: "managed",
      binaryPath: `/tmp/agent/bin/0.2.207/${sha256}/bigbud-remote-agent`,
      statePath: "/tmp/agent/runtimes/g1",
      socketPath: "/tmp/agent/runtimes/g1/supervisor.sock",
      logPath: "/tmp/agent/runtimes/g1/supervisor.log",
    },
    epoch: "epoch-1",
    resourceId: terminalId,
    state: "may-have-been-sent",
    terminalCwd: "/work",
    digest: Buffer.from(remoteAgentPtyRequestDigest({ target: "ssh:host", cwd: "/work" })).toString(
      "hex",
    ),
    outputSequence: 0,
    nextInputSequence: 1,
    inputAcknowledged: 0,
  };
}

const observation = (route: RemoteAgentOwner) => ({
  ptyId: route.resourceId,
  requestDigest: Buffer.from(route.digest, "hex"),
  state: "running",
  pid: 42,
  nextSequence: 1,
  firstRetainedSequence: 1,
  verifiedExit: false,
  launchStatus: "unconfirmed",
});

describe("terminal discovery after backend restart", () => {
  it("reads bounded keyset pages from reopened SQLite and leaves owner bytes unchanged", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bigbud-terminal-discovery-"));
    const filename = join(directory, "owners.sqlite");
    let runtime = ManagedRuntime.make(NodeSqlite.layer({ filename }));
    try {
      await runtime.runPromise(Effect.andThen(OwnersMigration, ReplayMigration));
      const first = await runtime.runPromise(makeRemoteAgentRuntimeBindings);
      const routes = [owner("a"), owner("b"), owner("c")];
      for (const route of routes) await first.reserve(route);
      await first.reserve({
        ...owner("process"),
        ownerKey: "process:test",
        terminalCwd: undefined,
      });
      await first.reserve({ ...owner("other"), target: "ssh:other", terminalCwd: undefined });
      await runtime.dispose();
      runtime = ManagedRuntime.make(NodeSqlite.layer({ filename }));
      const reopened = await runtime.runPromise(makeRemoteAgentRuntimeBindings);
      const firstPage = await reopened.listTerminalOwners("ssh:host", "", 2);
      expect(firstPage.owners.map((o) => o.resourceId)).toEqual(["a", "b"]);
      const second = await reopened.listTerminalOwners("ssh:host", firstPage.nextCursor, 2);
      expect(second.owners.map((o) => o.resourceId)).toEqual(["c"]);
      expect(second.nextCursor).toBe("");
      for (const route of routes) expect(await reopened.get(route.ownerKey)).toEqual(route);
      await expect(reopened.listTerminalOwners("ssh:host", "", 101)).rejects.toThrow("limit");
    } finally {
      await runtime.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("joins retained owner identity and deduplicates one supervisor read", async () => {
    const routes = [owner("a"), owner("b"), owner("c")];
    const list = vi.fn(async () => [
      observation(routes[0]!),
      { ...observation(routes[1]!), state: "exited", verifiedExit: true },
    ]);
    const discovery = new RemoteAgentTerminalDiscovery(
      { listTerminalOwners: async () => ({ owners: routes, nextCursor: "" }) },
      { list },
    );
    const page = await discovery.list("ssh:host");
    expect(page.sessions.map((s) => s.status)).toEqual(["running", "stopped", "unknown"]);
    expect(page.sessions[2]?.reason).toBe("resource-not-observed");
    expect(page.sessions[0]).toMatchObject({
      threadId: "thread-1",
      terminalId: "a",
      cwd: "/work",
      resourceId: "a",
    });
    expect(list).toHaveBeenCalledOnce();
    expect(routes.every((r) => r.state === "may-have-been-sent")).toBe(true);
  });
  it("keeps routes unknown on unavailable runtime or digest conflict", async () => {
    const route = owner("a");
    const owners = { listTerminalOwners: async () => ({ owners: [route], nextCursor: "" }) };
    const unavailable = new RemoteAgentTerminalDiscovery(owners, {
      list: async () => {
        throw new Error("old epoch");
      },
    });
    expect((await unavailable.list("ssh:host")).sessions[0]).toMatchObject({
      status: "unknown",
      reason: "runtime-unavailable",
    });
    const conflict = new RemoteAgentTerminalDiscovery(owners, {
      list: async () => [{ ...observation(route), requestDigest: new Uint8Array([1]) }],
    });
    expect((await conflict.list("ssh:host")).sessions[0]).toMatchObject({
      status: "unknown",
      reason: "identity-conflict",
    });
  });
  it("binds saved cwd to the durable request digest and permits legacy missing metadata", () => {
    const route = owner("a");
    expect(parseRemoteAgentOwner(JSON.stringify(route))).toEqual(route);
    expect(() =>
      parseRemoteAgentOwner(JSON.stringify({ ...route, terminalCwd: "/other" })),
    ).toThrow("identity conflict");
    const { terminalCwd: _, ...legacy } = route;
    expect(parseRemoteAgentOwner(JSON.stringify(legacy))).toEqual(legacy);
  });
});

describe("discovered terminal attachment fencing", () => {
  it.each([undefined, owner("changed")])(
    "refuses stale discovery before any connection or mutation",
    async (retained) => {
      const getBound = vi.fn();
      const reserve = vi.fn();
      const rollbackPrepared = vi.fn();
      const store = {
        get: async () => retained,
        reserve,
        rollbackPrepared,
      } as unknown as RemoteAgentOwnerStore;
      const open = makeOwnedRemoteAgentPty(
        { getBound } as unknown as RemoteAgentConnectionPool,
        () => store,
      );
      await expect(
        open({ ...spawnInput(), recoverOnly: true, expectedRemoteResourceId: "original" }),
      ).rejects.toThrow("identity changed");
      expect(getBound).not.toHaveBeenCalled();
      expect(reserve).not.toHaveBeenCalled();
      expect(rollbackPrepared).not.toHaveBeenCalled();
    },
  );
});
