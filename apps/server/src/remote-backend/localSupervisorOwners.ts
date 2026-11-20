import type { RemoteAgentOwnerStore } from "../remote-agent/remoteAgentOwners.ts";

/** Retained state remains readable during repair; every local mutation requires current authority. */
export function makeLocalSupervisorAuthorityOwners(input: {
  readonly owners: RemoteAgentOwnerStore;
  readonly targetId: string;
  readonly assertAuthority: () => Promise<void>;
}): RemoteAgentOwnerStore {
  const { owners, targetId, assertAuthority } = input;
  if (!/^remote-backend:[a-f0-9]{32}$/.test(targetId))
    throw new Error("A local owner view requires an exact backend authority target.");
  const target = (selected: string) => {
    if (selected !== targetId)
      throw new Error("Terminal ownership belongs to another backend authority.");
  };
  const rollback = owners.rollbackPrepared;
  const reconcile = owners.reconcileRuntime;
  const references = owners.hasDurableReferences;
  const connections = owners.listConnectionIds;
  const terminals = owners.listTerminalOwners;
  const known = owners.knownTargets;
  return {
    getBinding: (selected) => {
      target(selected);
      return owners.getBinding(selected);
    },
    get: async (key) => {
      const owner = await owners.get(key);
      if (owner) target(owner.target);
      return owner;
    },
    referencedBuildIds: (selected) => {
      target(selected);
      return owners.referencedBuildIds(selected);
    },
    bindConnection: async (selected, id, binding) => {
      target(selected);
      await assertAuthority();
      return owners.bindConnection(selected, id, binding);
    },
    reserve: async (owner, replaceTerminal) => {
      target(owner.target);
      await assertAuthority();
      return owners.reserve(owner, replaceTerminal, targetId);
    },
    update: async (key, transition) => {
      await assertAuthority();
      return owners.update(
        key,
        (owner) => {
          target(owner.target);
          const next = transition(owner);
          target(next.target);
          return next;
        },
        targetId,
      );
    },
    ...(rollback
      ? {
          rollbackPrepared: async (key: string, resource: string) => {
            await assertAuthority();
            return rollback(key, resource, targetId);
          },
        }
      : {}),
    ...(reconcile
      ? {
          reconcileRuntime: async (selected: string, generation: string, epoch: string) => {
            target(selected);
            await assertAuthority();
            return reconcile(selected, generation, epoch);
          },
        }
      : {}),
    ...(references
      ? {
          hasDurableReferences: (selected: string, id: string) => {
            target(selected);
            return references(selected, id);
          },
        }
      : {}),
    ...(connections
      ? {
          listConnectionIds: (selected: string) => {
            target(selected);
            return connections(selected);
          },
        }
      : {}),
    ...(terminals
      ? {
          listTerminalOwners: (selected: string, after?: string, limit?: number) => {
            target(selected);
            return terminals(selected, after, limit);
          },
        }
      : {}),
    ...(known
      ? { knownTargets: async () => (await known()).filter((selected) => selected === targetId) }
      : {}),
    // Global terminal-history maintenance is intentionally absent from this local transport view.
  };
}
