import type { SshMonitorHealthOwner } from "./sshMonitor.healthOwner.ts";
import {
  readSshOwnerProductionOwner,
  type SshOwnerProductionRegistration,
} from "./sshOwnerProductionRegistry.ts";
import { descriptorServesTarget } from "./sshOwnerProductionTargets.ts";

/**
 * Production SSH monitor reachability (W7): the live owner's typed
 * `sample_health` for the exact target, per probe. A missing owner, a refused
 * target or any owner error is `unavailable`, never evidence that the transport
 * died; only an answered sample can report `unreachable`.
 *
 * @module sshMonitor.productionHealth
 */
export function makeProductionSshMonitorHealth(
  read: () => SshOwnerProductionRegistration | undefined = readSshOwnerProductionOwner,
): SshMonitorHealthOwner {
  return {
    async sampleHealth(targetId, signal) {
      if (signal.aborted) return "unavailable";
      try {
        const live = read();
        if (!live) return "unavailable";
        const descriptor = await live.descriptorFor(targetId);
        if (!descriptorServesTarget(descriptor, targetId) || signal.aborted) return "unavailable";
        const bound = live.handle.target(descriptor);
        const reachable = await bound.sampleCancellableProofHealth(bound.targetId, signal);
        if (signal.aborted) return "unavailable";
        return reachable ? "reachable" : "unreachable";
      } catch {
        return "unavailable";
      }
    },
  };
}
