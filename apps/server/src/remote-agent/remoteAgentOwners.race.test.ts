import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, ManagedRuntime } from "effect";
import * as NodeSqlite from "../persistence/NodeSqliteClient.ts";
import OwnersMigration from "../persistence/Migrations/111_RemoteAgentRuntimeBindings.ts";
import ReplayMigration from "../persistence/Migrations/112_RemoteAgentReplayFence.ts";
const Migration = Effect.andThen(OwnersMigration, ReplayMigration);
import { makeRemoteAgentRuntimeBindings } from "../persistence/Layers/RemoteAgentRuntimeBindings.ts";
import type { RemoteAgentOwner } from "./remoteAgentOwners.ts";
import { currentRemoteAgentController } from "./remoteAgentController.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function owner(ownerKey: string, resourceId: string): RemoteAgentOwner {
  const sha256 = "a".repeat(64);
  return {
    ownerKey,
    target: "ssh:race",
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
    resourceId,
    digest: "b".repeat(64),
    state: "prepared",
    outputSequence: 0,
    nextInputSequence: 1,
    inputAcknowledged: 0,
  };
}

describe("durable remote owner reservation races", () => {
  it("rejects an old invocation after a terminal owner slot is reused", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bigbud-owner-reuse-"));
    directories.push(directory);
    const runtime = ManagedRuntime.make(
      NodeSqlite.layer({ filename: join(directory, "owners.sqlite") }),
    );
    try {
      await runtime.runPromise(Migration);
      const store = await runtime.runPromise(makeRemoteAgentRuntimeBindings);
      const first = { ...owner("process:reused", "first"), invocationId: "first" };
      await store.reserve(first);
      await store.update(first.ownerKey, (current) => ({ ...current, state: "terminal" }));
      await store.reserve({ ...first, resourceId: "second", invocationId: "second" }, true);
      await store.update(first.ownerKey, (current) => ({ ...current, state: "terminal" }));
      await expect(store.reserve(first, true)).rejects.toThrow("expired");
    } finally {
      await runtime.dispose();
    }
  });
  it("returns one exact process and PTY owner winner during terminal replacement", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bigbud-owner-race-"));
    directories.push(directory);
    const runtime = ManagedRuntime.make(
      NodeSqlite.layer({ filename: join(directory, "owners.sqlite") }),
    );
    try {
      await runtime.runPromise(Migration);
      const store = await runtime.runPromise(makeRemoteAgentRuntimeBindings);
      for (const key of ["process:race", "terminal:race"]) {
        const original = await store.reserve(owner(key, "original"));
        await store.update(key, (current) => ({ ...current, state: "terminal" }));
        const [left, right] = await Promise.all([
          store.reserve(owner(key, `${key}-left`), true),
          store.reserve(owner(key, `${key}-right`), true),
        ]);
        expect(original.resourceId).toBe("original");
        expect(left).toEqual(right);
        expect(left.ownerKey).toBe(key);
        expect(left.runtime.generation).toBe("g1");
        expect([`${key}-left`, `${key}-right`]).toContain(left.resourceId);
      }
    } finally {
      await runtime.dispose();
    }
  });

  it("bounds terminal owner history without deleting uncertain routes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bigbud-owner-retention-"));
    directories.push(directory);
    const runtime = ManagedRuntime.make(
      NodeSqlite.layer({ filename: join(directory, "owners.sqlite") }),
    );
    try {
      await runtime.runPromise(Migration);
      const store = await runtime.runPromise(makeRemoteAgentRuntimeBindings);
      for (let index = 0; index < 260; index++) {
        const key = `process:terminal-${index}`;
        await store.reserve(owner(key, `resource-${index}`));
        await store.update(key, (current) => ({ ...current, state: "terminal" }));
      }
      const unknownKey = "process:unknown";
      await store.reserve({ ...owner(unknownKey, "unknown-resource"), state: "outcome-unknown" });
      await store.pruneTerminal?.();
      expect(await store.get("process:terminal-0")).toBeUndefined();
      expect(await store.get("process:terminal-3")).toBeUndefined();
      expect(await store.get("process:terminal-259")).toBeDefined();
      expect(await store.get(unknownKey)).toBeDefined();
      await expect(store.reserve(owner("process:terminal-0", "replacement"))).rejects.toThrow(
        "expired",
      );
      const restarted = await runtime.runPromise(makeRemoteAgentRuntimeBindings);
      await expect(restarted.reserve(owner("process:terminal-3", "replacement"))).rejects.toThrow(
        "expired",
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("reclaims only a prepared owner whose controller process is proven dead", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bigbud-owner-controller-"));
    directories.push(directory);
    const runtime = ManagedRuntime.make(
      NodeSqlite.layer({ filename: join(directory, "owners.sqlite") }),
    );
    try {
      await runtime.runPromise(Migration);
      const store = await runtime.runPromise(makeRemoteAgentRuntimeBindings);
      const current = currentRemoteAgentController();
      for (const key of ["process:prepared", "terminal:prepared", "workspace-write:prepared"]) {
        await store.reserve({
          ...owner(key, "dead-resource"),
          controllerId: "controller:dead",
          controllerPid: 99_999_999,
          controllerStartedAt: "dead-start",
        });
        const recovered = await store.reserve({
          ...owner(key, "recovered-resource"),
          controllerId: current.id,
          controllerPid: current.pid,
          controllerStartedAt: current.startedAt,
        });
        expect(recovered.resourceId).toBe("recovered-resource");
      }

      const live = await store.reserve({
        ...owner("process:live", "live-resource"),
        controllerId: current.id,
        controllerPid: current.pid,
        controllerStartedAt: current.startedAt,
      });
      const blocked = await store.reserve({
        ...owner("process:live", "replacement-resource"),
        controllerId: current.id,
        controllerPid: current.pid,
        controllerStartedAt: current.startedAt,
      });
      expect(blocked.resourceId).toBe(live.resourceId);
    } finally {
      await runtime.dispose();
    }
  });
});
