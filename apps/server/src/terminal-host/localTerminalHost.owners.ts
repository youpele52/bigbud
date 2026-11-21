import type { RemoteAgentControl } from "../remote-agent/remoteAgentControl.ts";
import { emptyRemoteAgentRegistry } from "../remote-agent/remoteAgentInstall.registry.ts";
import type { RemoteAgentOwnerStore } from "../remote-agent/remoteAgentOwners.ts";
import { remoteAgentBuildId, type RemoteAgentRuntime } from "../remote-agent/remoteAgentRuntime.ts";
import { LOCAL_TERMINAL_HOST_TARGET_ID } from "./localTerminalHost.paths.ts";

const assertLocalTarget = (target: string) => {
  if (target !== LOCAL_TERMINAL_HOST_TARGET_ID)
    throw new Error("Terminal ownership belongs to another execution target.");
};

/** The shared durable store, narrowed to `local-terminal-host` rows. */
export function makeLocalTerminalHostOwners(owners: RemoteAgentOwnerStore): RemoteAgentOwnerStore {
  const rollback = owners.rollbackPrepared;
  const reconcile = owners.reconcileRuntime;
  const references = owners.hasDurableReferences;
  const connections = owners.listConnectionIds;
  const terminals = owners.listTerminalOwners;
  return {
    getBinding: (target) => {
      assertLocalTarget(target);
      return owners.getBinding(target);
    },
    get: async (key) => {
      const owner = await owners.get(key);
      if (owner) assertLocalTarget(owner.target);
      return owner;
    },
    referencedBuildIds: (target) => {
      assertLocalTarget(target);
      return owners.referencedBuildIds(target);
    },
    bindConnection: (target, id, binding) => {
      assertLocalTarget(target);
      return owners.bindConnection(target, id, binding);
    },
    reserve: (owner, replaceTerminal) => {
      assertLocalTarget(owner.target);
      return owners.reserve(owner, replaceTerminal, LOCAL_TERMINAL_HOST_TARGET_ID);
    },
    update: (key, transition) =>
      owners.update(
        key,
        (owner) => {
          assertLocalTarget(owner.target);
          const next = transition(owner);
          assertLocalTarget(next.target);
          return next;
        },
        LOCAL_TERMINAL_HOST_TARGET_ID,
      ),
    ...(rollback
      ? {
          rollbackPrepared: (key: string, resource: string) =>
            rollback(key, resource, LOCAL_TERMINAL_HOST_TARGET_ID),
        }
      : {}),
    ...(reconcile
      ? {
          reconcileRuntime: (target: string, generation: string, epoch: string) => {
            assertLocalTarget(target);
            return reconcile(target, generation, epoch);
          },
        }
      : {}),
    ...(references
      ? {
          hasDurableReferences: (target: string, id: string) => {
            assertLocalTarget(target);
            return references(target, id);
          },
        }
      : {}),
    ...(connections
      ? {
          listConnectionIds: (target: string) => {
            assertLocalTarget(target);
            return connections(target);
          },
        }
      : {}),
    ...(terminals
      ? {
          listTerminalOwners: (target: string, after?: string, limit?: number) => {
            assertLocalTarget(target);
            return terminals(target, after, limit);
          },
        }
      : {}),
  };
}

const MAX_OWNER_PAGES = 64;

/**
 * Whether durable owners still reference a generation (connectionId = `state-<n>`, plus its epoch
 * when known). `undefined` means the store could not answer, which callers treat as live.
 */
export async function localTerminalHostGenerationHasOwners(
  owners: Pick<RemoteAgentOwnerStore, "listTerminalOwners">,
  connectionId: string,
  epoch: string | undefined,
): Promise<boolean | undefined> {
  if (!owners.listTerminalOwners) return undefined;
  try {
    let cursor = "";
    for (let page = 0; page < MAX_OWNER_PAGES; page++) {
      const result = await owners.listTerminalOwners(LOCAL_TERMINAL_HOST_TARGET_ID, cursor, 100);
      for (const owner of result.owners) {
        if (owner.state === "terminal" || owner.connectionId !== connectionId) continue;
        if (epoch === undefined || owner.epoch === epoch) return true;
      }
      if (!result.nextCursor) return false;
      cursor = result.nextCursor;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build pins for local owners. The local host has no remote install registry; pins only need
 * a present build entry for every adopted generation's runtime, so this stays in memory.
 */
export function makeLocalTerminalHostPinRegistry(
  knownRuntimes: () => Promise<ReadonlyArray<RemoteAgentRuntime>>,
): RemoteAgentControl["registry"] {
  let state = emptyRemoteAgentRegistry();
  let tail: Promise<unknown> = Promise.resolve();
  const withBuilds = async () => {
    const runtimes = await knownRuntimes();
    const builds = new Map(state.builds.map((build) => [build.id, build]));
    for (const runtime of runtimes) {
      const id = remoteAgentBuildId(runtime);
      if (!builds.has(id))
        builds.set(id, {
          id,
          runtime,
          health: "healthy",
          promotion: 0,
          binary: "present",
          authenticated: false,
        });
    }
    state = { ...state, builds: [...builds.values()] };
    return state;
  };
  const serialized = <A>(run: () => Promise<A>): Promise<A> => {
    const next = tail.then(run, run);
    tail = next.catch(() => undefined);
    return next;
  };
  return {
    read: () => serialized(withBuilds),
    update: (transition) =>
      serialized(async () => {
        state = transition(await withBuilds());
        return state;
      }),
  };
}
