import type { RemoteAgentControl } from "./remoteAgentControl.ts";
import { cleanupRemoteAgentBuilds } from "./remoteAgentInstall.cleanup.ts";
import { retireManagedRemoteAgentBuild } from "./remoteAgentInstall.retirement.ts";

/**
 * `--replace` after activation: reclaim ordinary cleanup candidates, then retire the managed
 * predecessor when it is provably unreferenced. A live predecessor supervisor is asked to shut
 * down with `--shutdown-supervisor`, which the agent accepts only when idle (no live process
 * operations, unsettled PTYs, watchers or subscribers); busy work is never interrupted and the
 * build is reported as cleanup-deferred instead.
 */
export async function retireRemoteAgentBuildsForReplace(input: {
  readonly target: string;
  readonly control: RemoteAgentControl;
  readonly referencedBuildIds?: () => Promise<ReadonlySet<string>>;
  readonly beginRetirement?: (generation: string) => Promise<() => void>;
}): Promise<{ readonly deleted: number; readonly deferred: number }> {
  const cleanup = await cleanupRemoteAgentBuilds(
    input.control,
    input.referencedBuildIds,
    input.target,
  );
  let deleted = cleanup.deleted;
  const state = await input.control.registry.read();
  const predecessor = state.builds.find((build) => build.id === state.predecessor);
  if (
    predecessor &&
    predecessor.id !== state.current &&
    predecessor.runtime.origin === "managed" &&
    predecessor.binary === "present" &&
    input.referencedBuildIds
  ) {
    // Without durable local owner evidence the predecessor cannot be proven unreferenced.
    const references = await input.referencedBuildIds().catch(() => null);
    if (references && !references.has(predecessor.id)) {
      const result = await retireManagedRemoteAgentBuild({
        control: input.control,
        buildId: predecessor.id,
        reservationId: `retire-replace-${predecessor.runtime.generation}`,
        referencedBuildIds: references,
        ...(input.beginRetirement ? { beginRetirement: input.beginRetirement } : {}),
        withdrawPredecessor: true,
        allowLiveShutdown: true,
        recheckReferencedBuildIds: input.referencedBuildIds,
      });
      if (result === "deleted") deleted += 1;
    }
  }
  // Deferred counts older bigbud-managed builds whose bytes may remain (present, or mid-deletion),
  // never the active or pending build and never user-managed legacy installs bigbud won't retire.
  const after = await input.control.registry.read();
  const deferred = after.builds.filter(
    (build) =>
      build.runtime.origin === "managed" &&
      (build.binary === "present" || build.binary === "deleting") &&
      build.id !== after.current &&
      build.id !== after.pending,
  ).length;
  return { deleted, deferred };
}
