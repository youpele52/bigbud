import { describe, expect, it, vi } from "vitest";
import type { RemoteAgentOwnerStore } from "../remote-agent/remoteAgentOwners.ts";
import { profileOwner } from "../remote-agent/remoteAgentOwnedPty.profile.testUtils.ts";
import { makeLocalSupervisorAuthorityOwners } from "./localSupervisorOwners.ts";

function fixture(refused: boolean) {
  const targetId = `remote-backend:${"a".repeat(32)}`;
  const owner = { ...profileOwner(), target: targetId };
  const binding = { runtime: owner.runtime, expectedEpoch: owner.epoch };
  const owners: RemoteAgentOwnerStore = {
    getBinding: vi.fn(async () => binding),
    bindConnection: vi.fn(async () => undefined),
    get: vi.fn(async () => owner),
    reserve: vi.fn<RemoteAgentOwnerStore["reserve"]>(async (candidate) => candidate),
    update: vi.fn<RemoteAgentOwnerStore["update"]>(async (_key, transition) => transition(owner)),
    rollbackPrepared: vi.fn(async () => true),
    reconcileRuntime: vi.fn(async () => undefined),
    referencedBuildIds: vi.fn(async () => new Set(["retained"])),
    knownTargets: vi.fn(async () => [targetId, "ssh:other"]),
    pruneTerminal: vi.fn(async () => 99),
  };
  const assertAuthority = vi.fn(async () => {
    if (refused) throw new Error("authority refused");
  });
  return {
    targetId,
    owner,
    binding,
    owners,
    assertAuthority,
    view: makeLocalSupervisorAuthorityOwners({ owners, targetId, assertAuthority }),
  };
}

describe("authority-scoped retained SQL owner view", () => {
  it("keeps retained reads available but refuses every mutation and exposes no global prune", async () => {
    const f = fixture(true);
    expect(await f.view.get(f.owner.ownerKey)).toEqual(f.owner);
    expect(await f.view.getBinding(f.targetId)).toEqual(f.binding);
    expect(await f.view.referencedBuildIds(f.targetId)).toEqual(new Set(["retained"]));
    expect(await f.view.knownTargets!()).toEqual([f.targetId]);
    const results = await Promise.allSettled([
      f.view.bindConnection(f.targetId, "new", f.binding),
      f.view.reserve(f.owner, true),
      f.view.update(f.owner.ownerKey, (owner) => owner),
      f.view.rollbackPrepared!(f.owner.ownerKey, f.owner.resourceId),
      f.view.reconcileRuntime!(f.targetId, f.owner.runtime.generation, f.owner.epoch),
    ]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    for (const operation of [
      f.owners.bindConnection,
      f.owners.reserve,
      f.owners.update,
      f.owners.rollbackPrepared,
      f.owners.reconcileRuntime,
      f.owners.pruneTerminal,
    ])
      expect(operation).not.toHaveBeenCalled();
    expect(f.view.pruneTerminal).toBeUndefined();
  });
  it("requires exact target and forwards atomic target scope to reservation and rollback", async () => {
    const f = fixture(false);
    await expect(f.view.reserve({ ...f.owner, target: "ssh:other" }, true)).rejects.toThrow(
      "another backend authority",
    );
    expect(f.owners.reserve).not.toHaveBeenCalled();
    await f.view.reserve(f.owner, true);
    expect(f.owners.reserve).toHaveBeenCalledWith(f.owner, true, f.targetId);
    await f.view.rollbackPrepared!(f.owner.ownerKey, f.owner.resourceId);
    expect(f.owners.rollbackPrepared).toHaveBeenCalledWith(
      f.owner.ownerKey,
      f.owner.resourceId,
      f.targetId,
    );
    await f.view.reconcileRuntime!(f.targetId, f.owner.runtime.generation, f.owner.epoch);
    expect(f.owners.reconcileRuntime).toHaveBeenCalledWith(
      f.targetId,
      f.owner.runtime.generation,
      f.owner.epoch,
    );
    await expect(
      f.view.update(f.owner.ownerKey, (owner) => ({ ...owner, target: "ssh:other" })),
    ).rejects.toThrow("another backend authority");
  });
});
