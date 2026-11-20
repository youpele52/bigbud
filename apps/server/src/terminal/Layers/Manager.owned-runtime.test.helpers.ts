import { Deferred, Effect } from "effect";
import { vi } from "vitest";
import type {
  RemoteAgentOwner,
  RemoteAgentOwnerStore,
} from "../../remote-agent/remoteAgentOwners.ts";
import { RemoteAgentConnectionPool } from "../../remote-agent/remoteAgentConnectionPool.ts";
import { makeRemoteAgentRegistryStore } from "../../remote-agent/remoteAgentInstall.registry.store.ts";
import { profileOwner } from "../../remote-agent/remoteAgentOwnedPty.profile.testUtils.ts";
import { remoteAgentPtyRequestDigest } from "../../remote-agent/remoteAgentShellLaunch.ts";
import type { OwnedPtyRuntime } from "../Services/OwnedPtyRuntime.ts";
import { PtySpawnError, type PtySpawnInput } from "../Services/PTY.ts";
import { FakePtyAdapter, FakePtyProcess } from "./Manager.test.helpers.ts";

export function ownedRuntimeFixture() {
  const rows = new Map<string, RemoteAgentOwner>();
  const store: RemoteAgentOwnerStore = {
    getBinding: async () => undefined,
    bindConnection: async () => {},
    get: async (key) => rows.get(key),
    reserve: async (owner) => {
      rows.set(owner.ownerKey, owner);
      return owner;
    },
    update: async (key, change) => {
      const owner = rows.get(key);
      if (!owner) throw new Error("Missing owner");
      const next = change(owner);
      rows.set(key, next);
      return next;
    },
    referencedBuildIds: async () => new Set(["retained-build"]),
    listTerminalOwners: async (target, after = "", limit = 100) => ({
      owners: [...rows.values()]
        .filter((owner) => owner.target === target && owner.ownerKey > after)
        .toSorted((a, b) => a.ownerKey.localeCompare(b.ownerKey))
        .slice(0, limit),
      nextCursor: "",
    }),
  };
  const pool = new RemoteAgentConnectionPool({
    create: async () => {
      throw new Error("Unexpected fixture transport");
    },
  });
  const registry = makeRemoteAgentRegistryStore("/unused-manager-fixture", {
    run: async () => {
      throw new Error("Unexpected fixture registry command");
    },
  });
  const runtime: OwnedPtyRuntime = {
    targetId: `remote-backend:${"a".repeat(32)}`,
    pool,
    owners: () => store,
    control: async () => ({ registry }),
    pidNamespace: "backend-host",
  };
  return { runtime, rows, store };
}

export class PersistentLocalAdapter extends FakePtyAdapter {
  readonly ownership = ownedRuntimeFixture();
  readonly detach = vi.fn();
  readonly detachRemote = vi.fn(async () => {});
  readonly prepareRestart = vi.fn(async () => {
    this.retained?.emitExit({ exitCode: 0, signal: null });
    for (const [key, owner] of this.ownership.rows)
      this.ownership.rows.set(key, { ...owner, state: "terminal" });
    this.retained = undefined;
  });
  private retained: FakePtyProcess | undefined;
  blockSpawn: Deferred.Deferred<void> | undefined;
  readonly ownedRuntimeForTarget = (target: string) =>
    target === "local" ? this.ownership.runtime : undefined;

  override spawn(input: PtySpawnInput) {
    return Effect.gen({ self: this }, function* () {
      this.spawnInputs.push(input);
      if (this.blockSpawn) {
        yield* Deferred.succeed(this.blockSpawn, undefined);
        return yield* Effect.never;
      }
      if (input.recoverOnly && !this.retained)
        return yield* new PtySpawnError({
          adapter: "fixture-owned",
          message: "No durable process to recover",
        });
      if (!this.retained) {
        this.retained = new FakePtyProcess(19000);
        this.processes.push(this.retained);
        const ownerKey = `terminal:${input.ownerKey}`;
        const target = this.ownership.runtime.targetId;
        this.ownership.rows.set(ownerKey, {
          ...profileOwner(),
          ownerKey,
          target,
          terminalCwd: input.cwd,
          digest: Buffer.from(remoteAgentPtyRequestDigest({ target, cwd: input.cwd })).toString(
            "hex",
          ),
        });
      }
      return Object.assign(this.retained, {
        pidDomain: "remote" as const,
        recovered: input.recoverOnly === true,
        remoteResourceId: "pty-1",
        detach: this.detach,
        detachRemote: this.detachRemote,
        prepareRestart: this.prepareRestart,
      });
    });
  }
}
