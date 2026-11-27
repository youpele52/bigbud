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
  /** Present when a live owner answered the shutdown. */
  readonly attachCleared?: boolean;
  /** Hex epoch of the owner that shut down; present only with a live owner. */
  readonly ownerEpoch?: string;
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

export const closeSshOwnerForDrain = (
  read: typeof readSshOwnerProductionOwner = readSshOwnerProductionOwner,
): Effect.Effect<OwnerDrainReport, Error> =>
  Effect.tryPromise({
    try: async () => {
      const handle = read()?.handle;
      const shutdown = handle?.shutdownForDrain;
      if (!handle || !shutdown) return { closed: 0, failed: 0, leases: 0 };
      const epoch = handle.ownerEpoch;
      const report = await shutdown();
      return {
        closed: report.mastersClosed,
        failed: 0,
        leases: report.leasesClosed,
        attachCleared: report.attachCleared,
        ...(epoch instanceof Uint8Array ? { ownerEpoch: hex(epoch) } : {}),
      };
    },
    catch: (cause) =>
      cause instanceof Error ? cause : new Error("The SSH owner did not shut down for the drain."),
  });
