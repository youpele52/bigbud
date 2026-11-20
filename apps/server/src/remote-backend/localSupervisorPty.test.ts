import { beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { PtyProcess, PtySpawnInput } from "../terminal/Services/PTY.ts";
import type { makeOwnedRemoteAgentPty } from "../remote-agent/remoteAgentOwnedPty.ts";
import type { RemoteAgentOwnerStore, RemoteAgentOwner } from "../remote-agent/remoteAgentOwners.ts";
import { makeRemoteAgentRegistryStore } from "../remote-agent/remoteAgentInstall.registry.store.ts";
import { makeLocalSupervisorPty } from "./localSupervisorPty.ts";
import { localSupervisorTarget } from "./localSupervisorIdentity.ts";
import { makeRemoteAgentPtyAdapter } from "../remote-agent/remoteAgentPtyAdapter.ts";

const f = vi.hoisted(() => ({
  build: vi.fn<(...args: Parameters<typeof makeOwnedRemoteAgentPty>) => void>(),
  spawn: vi.fn<(input: PtySpawnInput) => Promise<PtyProcess>>(),
}));
vi.mock("../remote-agent/remoteAgentOwnedPty.ts", () => ({
  makeOwnedRemoteAgentPty: (...args: Parameters<typeof makeOwnedRemoteAgentPty>) => {
    f.build(...args);
    return f.spawn;
  },
}));

function fixture() {
  const rows = new Map<string, RemoteAgentOwner>();
  const owners: RemoteAgentOwnerStore = {
    getBinding: async () => undefined,
    bindConnection: async () => {},
    get: async (key) => rows.get(key),
    reserve: async (owner) => {
      rows.set(owner.ownerKey, owner);
      return owner;
    },
    update: async (key, change) => {
      const owner = rows.get(key);
      if (!owner) throw new Error("Missing fixture owner");
      const next = change(owner);
      rows.set(key, next);
      return next;
    },
    referencedBuildIds: async () => new Set(),
  };
  const registry = makeRemoteAgentRegistryStore("/fixture-unused", {
    run: async () => {
      throw new Error("Unexpected registry command");
    },
  });
  const resolveBinding = vi.fn(async () => undefined);
  const local = makeLocalSupervisorPty({
    authorityId: "a".repeat(32),
    owners,
    registry,
    resolveBinding,
  });
  return { local, owners, registry, resolveBinding };
}
const input = (): PtySpawnInput => ({
  shell: "/bin/bash",
  args: ["--noprofile"],
  cwd: "/workspace",
  cols: 80,
  rows: 24,
  env: { TERM: "xterm-256color" },
  ownerKey: '["thread","pane"]',
  executionTargetId: "local",
});
let process: PtyProcess;
beforeEach(() => {
  vi.clearAllMocks();
  process = {
    pidDomain: "remote",
    pid: 42,
    remoteResourceId: "fixture-resource",
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    detach: vi.fn(),
    onData: () => () => {},
    onExit: () => () => {},
  };
  f.spawn.mockResolvedValue(process);
});

describe("authority-scoped local Rust PTY adapter", () => {
  it("keeps UI-local input while dispatching exact intent under the backend authority", async () => {
    const { local, owners } = fixture();
    const request = input();
    const wrapped = makeRemoteAgentPtyAdapter(local.adapter, {
      resolvePty: async () => {
        throw new Error("Unexpected SSH PTY resolution");
      },
      resolveWorkspace: async () => {
        throw new Error("Unexpected SSH workspace resolution");
      },
    });
    expect(wrapped.ownedRuntimeForTarget!("local")).toBe(local.runtime);
    expect(await Effect.runPromise(wrapped.spawn(request))).toBe(process);
    expect(request.executionTargetId).toBe("local");
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.spawn.mock.calls[0]?.[0]).toMatchObject({
      ownerKey: request.ownerKey,
      executionTargetId: localSupervisorTarget("a".repeat(32)),
      remoteCwd: request.cwd,
      shellLaunch: {
        executable: request.shell,
        args: request.args,
        cwd: request.cwd,
        requestedProfile: { host: { kind: "agent", hostId: local.runtime.targetId } },
      },
    });
    expect(local.adapter.ownedRuntimeForTarget!("local")).toBe(local.runtime);
    expect(local.adapter.ownedRuntimeForTarget!("ssh:alias")).toBeUndefined();
    expect(local.runtime.owners()).toBe(owners);
    expect(local.runtime.pidNamespace).toBe("backend-host");
    local.close();
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("cold-attaches without translating changed defaults or losing the expected resource fence", async () => {
    const { local } = fixture();
    await Effect.runPromise(
      local.adapter.spawn({
        ...input(),
        shell: "now-missing-shell",
        recoverOnly: true,
        expectedRemoteResourceId: "retained-resource",
      }),
    );
    const request = f.spawn.mock.calls[0]?.[0];
    expect(request?.shellLaunch).toBeUndefined();
    expect(request?.recoverySignal).toBeInstanceOf(AbortSignal);
    expect(request?.recoverySignal?.aborted).toBe(false);
    expect(request?.expectedRemoteResourceId).toBe("retained-resource");
    local.close();
  });

  it("never resolves a different authority through the local binding or registry lane", async () => {
    const { local, registry, resolveBinding } = fixture();
    const built = f.build.mock.calls[0]!;
    await expect(built[2]!("ssh:alias")).rejects.toThrow("another backend authority");
    await expect(built[3]!.openControl!("remote-backend:other")).rejects.toThrow(
      "another backend authority",
    );
    expect(resolveBinding).not.toHaveBeenCalled();
    expect(await built[3]!.openControl!(local.runtime.targetId)).toEqual({ registry });
    local.close();
  });

  it("refuses other targets, missing owners and a closed adapter before dispatch", async () => {
    const { local } = fixture();
    await expect(
      Effect.runPromise(local.adapter.spawn({ ...input(), executionTargetId: "ssh:alias" })),
    ).rejects.toThrow("another execution target");
    const ownerless = { ...input() };
    delete ownerless.ownerKey;
    await expect(Effect.runPromise(local.adapter.spawn(ownerless))).rejects.toThrow(
      "durable application terminal owner",
    );
    local.close();
    await expect(Effect.runPromise(local.adapter.spawn(input()))).rejects.toThrow("closed");
    expect(f.spawn).not.toHaveBeenCalled();
  });
});
