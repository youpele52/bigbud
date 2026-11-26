import type { Effect } from "effect";

import type { initializeProductionSshGuardedWriteJournal } from "../persistence/Layers/SshOwnerGuardedWriteJournal.ts";
import { PickerProofOwnerError } from "../ssh/sshOwnerPickerProof.client.ts";
import { applyGuardedWriteWithJournal } from "../ssh/sshOwnerPickerProof.guardedWriteJournal.ts";
import type { SshOwnerProductionRegistration } from "../ssh/sshOwnerProductionRegistry.ts";
import { descriptorServesTarget } from "../ssh/sshOwnerProductionTargets.ts";
import type { SelectedGuardedWorkspaceWrite } from "./wsSshOwnerDev.workspace.guarded.ts";

export type ProductionGuardedWriteJournal = Effect.Success<
  ReturnType<typeof initializeProductionSshGuardedWriteJournal>
>;

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/**
 * W2 T-files production guarded save for one exact target and root. The
 * journal scope binds the owner epoch and the target generation, so an intent
 * from another owner or generation is never replayed; the owner applies on the
 * target's own guarded-write lane only after the journal claim committed.
 */
export function productionGuardedWrite(
  read: () => SshOwnerProductionRegistration | undefined,
  journal: ProductionGuardedWriteJournal,
  targetId: string,
  cwd: string,
): SelectedGuardedWorkspaceWrite {
  return {
    apply: async (input) => {
      const live = read();
      if (!live) throw new PickerProofOwnerError("ownerUnavailable");
      const descriptor = await live.descriptorFor(targetId);
      if (!descriptorServesTarget(descriptor, targetId))
        throw new PickerProofOwnerError("targetMismatch");
      const bound = live.handle.target(descriptor);
      // An unresolved target has no generation yet: first resolve it.
      if (bound.generation.length === 0) await bound.inspectTrust();
      const profileId = `production:${hex(live.handle.ownerEpoch)}:${hex(bound.generation)}`;
      return applyGuardedWriteWithJournal(journal, bound, {
        profileId,
        targetId,
        cwd,
        ...input,
      });
    },
  };
}
