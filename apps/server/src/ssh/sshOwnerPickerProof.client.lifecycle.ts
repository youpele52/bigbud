import type { PickerProofPipe } from "./sshOwnerPickerProof.pipe.ts";

/**
 * Teardown verbs shared by the proof owner handle. `detach` leaves an owner
 * that owns an attachment endpoint alive; `reap` kills the exact spawned child.
 *
 * @module sshOwnerPickerProof.client.lifecycle
 */

export interface SpawnedPickerProofPipe extends PickerProofPipe {
  detach(): Promise<void>;
  retireSupervised(): Promise<void>;
  killForTest(): Promise<void>;
}

export function makePickerProofOwnerLifecycle(
  pipe: SpawnedPickerProofPipe,
  stopAdmission: () => Promise<void>,
) {
  return {
    async detach() {
      await stopAdmission();
      await pipe.detach();
    },
    async retireSupervised() {
      const drained = stopAdmission();
      await pipe.retireSupervised();
      await drained;
    },
    async killForTest() {
      const drained = stopAdmission();
      await pipe.killForTest();
      await drained;
    },
    async retireSpawned() {
      const drained = stopAdmission();
      await pipe.killForTest();
      await drained;
    },
  };
}
