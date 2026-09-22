import type { RemoteAgentControl } from "./remoteAgentControl.ts";
import { cleanupRemoteAgentBuilds } from "./remoteAgentInstall.cleanup.ts";
import type { RemoteAgentRegistryBuild } from "./remoteAgentInstall.registry.ts";
import {
  prepareRemoteAgentPredecessorRetirement,
  type RemoteAgentPredecessorCapacityResult,
} from "./remoteAgentInstall.retirement.ts";
import type { RemoteAgentInventory } from "./remoteAgentUpdate.inventory.ts";
import { reclaimUnregisteredRemoteAgentBuild } from "./remoteAgentInstall.orphan.ts";

/** Reconcile safely owned debris once before attempting stable-predecessor retirement. */
export async function prepareRemoteAgentInstallCapacity(input: {
  readonly target: string;
  readonly control: RemoteAgentControl;
  readonly build: RemoteAgentRegistryBuild;
  readonly inventory: RemoteAgentInventory;
  readonly referencedBuildIds?: () => Promise<ReadonlySet<string>>;
  readonly beginRetirement?: (generation: string) => Promise<() => void>;
}): Promise<RemoteAgentPredecessorCapacityResult> {
  if (
    input.inventory.uniqueDigests.has(input.build.runtime.sha256) ||
    input.inventory.uniqueDigests.size < 2
  )
    return "not-needed";

  const cleanup = await cleanupRemoteAgentBuilds(
    input.control,
    input.referencedBuildIds,
    input.target,
  ).catch(() => ({ deleted: 0, deferred: 0 }));
  if (cleanup.deleted > 0) return "reclaimed";

  if (
    await reclaimUnregisteredRemoteAgentBuild({
      control: input.control,
      inventory: input.inventory,
      ...(input.referencedBuildIds ? { referencedBuildIds: input.referencedBuildIds } : {}),
    })
  )
    return "reclaimed";

  return prepareRemoteAgentPredecessorRetirement(input);
}
