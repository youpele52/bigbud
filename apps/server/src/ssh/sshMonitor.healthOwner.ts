import type { PickerProofHealthClient } from "./sshOwnerPickerProof.client.health.ts";
import {
  SshOwnerStatusBroker,
  type SshOwnerStatusSubscriber,
} from "./sshMonitor.healthSubscription.ts";

export interface SshMonitorHealthOwner {
  sampleHealth(
    targetId: string,
    signal: AbortSignal,
  ): Promise<"reachable" | "unreachable" | "unavailable">;
}

export interface SshMonitorStatusOptions {
  /** Per-subscriber queue capacity; the broker requires at least two. */
  readonly capacity?: number;
  /** Owner/lease generation attached to published status. */
  readonly generation?: number;
}

export interface SelectedSshMonitorHealth extends SshMonitorHealthOwner {
  readonly targetId: string;
  readonly workspaceRoot: string;
  /** Bounded typed status for this exact target. Cancelling one does not affect others. */
  subscribeStatus(signal?: AbortSignal): SshOwnerStatusSubscriber;
  /** Advance the owner generation so queued status resyncs instead of replaying. */
  setStatusGeneration(generation: number): void;
  closeStatus(): void;
}

export function makeSelectedSshMonitorHealth(
  targetId: string,
  workspaceRoot: string,
  withOwner: (
    targetId: string,
    sample: (
      owner: Pick<PickerProofHealthClient, "sampleCancellableProofHealth">,
    ) => Promise<boolean>,
    signal: AbortSignal,
  ) => Promise<boolean>,
  options: SshMonitorStatusOptions = {},
): SelectedSshMonitorHealth {
  const status = new SshOwnerStatusBroker(targetId, options.generation ?? 0, options.capacity ?? 2);
  let sampleSequence = 0;
  return {
    targetId,
    workspaceRoot,
    subscribeStatus: (signal) => status.subscribe(signal),
    setStatusGeneration: (generation) => status.setGeneration(generation),
    closeStatus: () => status.close(),
    async sampleHealth(id, signal) {
      if (id !== targetId || signal.aborted) return "unavailable";
      const sequence = ++sampleSequence;
      let sample: "reachable" | "unreachable" | "unavailable";
      try {
        sample = (await withOwner(
          id,
          (owner) => owner.sampleCancellableProofHealth(id, signal),
          signal,
        ))
          ? "reachable"
          : "unreachable";
      } catch {
        // Denials, cooldown, and owner/storage loss are not observed transport failures.
        sample = "unavailable";
      }
      // A cancelled probe must not publish, even if the sample settled true.
      if (signal.aborted) return "unavailable";
      status.publish(sample, undefined, sequence);
      return sample;
    },
  };
}
