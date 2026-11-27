import * as Effect from "effect/Effect";

import { readSshOwnerProductionOwner } from "../ssh/sshOwnerProductionRegistry.ts";

/**
 * The drain's owner step (cutover §d1): the live production SSH owner closes every
 * control master and lease with confirmed teardown, clears its attach record and
 * exits before the backend lock is released, so no later backend can re-attach it.
 * With no live owner there is nothing to close.
 *
 * @module backendDrain.owner
 */
export interface OwnerDrainReport {
  readonly closed: number;
  readonly failed: number;
  readonly leases: number;
}

export const closeSshOwnerForDrain = (
  read: typeof readSshOwnerProductionOwner = readSshOwnerProductionOwner,
): Effect.Effect<OwnerDrainReport, Error> =>
  Effect.tryPromise({
    try: async () => {
      const shutdown = read()?.handle.shutdownForDrain;
      if (!shutdown) return { closed: 0, failed: 0, leases: 0 };
      const report = await shutdown();
      return { closed: report.mastersClosed, failed: 0, leases: report.leasesClosed };
    },
    catch: (cause) =>
      cause instanceof Error ? cause : new Error("The SSH owner did not shut down for the drain."),
  });
