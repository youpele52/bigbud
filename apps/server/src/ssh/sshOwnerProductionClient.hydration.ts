import type { PickerProofReconciliation } from "./sshOwnerPickerProof.client.session.types.ts";
import type { PickerProofHydratedStorage } from "./sshOwnerPickerProof.client.session.types.ts";
import { digestSshOwnerReconciliation } from "./sshOwnerPickerProof.codec.reconciliation.ts";
import { SshOwnerClientError } from "./sshOwnerProductionClient.errors.ts";
import type { SshOwnerHydrationSnapshot } from "./sshOwnerProductionHydration.ts";

/**
 * Admission gate for the hydration the boot sequence already reads.
 *
 * A production owner acknowledges the exact restart reconciliation set it
 * verified (unresolved retirement mirror + retained direct pane bindings). The
 * backend compares that acknowledgement with the snapshot it is about to admit
 * on, so local verification is never sufficient and a stale round cannot
 * survive a rebind.
 *
 * A pinned fixture owner keeps the v1 storage handshake and its local category
 * checks; those categories are never carried to a fixture owner.
 *
 * @module sshOwnerProductionClient.hydration
 */

export interface SshOwnerHydrationAck {
  /**
   * The primary target, when the profile names one. A production owner started
   * without a target hydrates each target on its first request instead, so the
   * target-scoped checks are skipped rather than invented.
   */
  readonly targetId?: string;
  readonly snapshot: SshOwnerHydrationSnapshot;
  readonly storage: PickerProofHydratedStorage | undefined;
  readonly aliasDescriptor: Uint8Array | undefined;
  /** Present when the owner completed the production reconciliation round. */
  readonly reconciliation?: PickerProofReconciliation | undefined;
  /** The exact set the owner acknowledged, for the freshness comparison. */
  readonly acknowledgedSnapshot?: SshOwnerHydrationSnapshot | undefined;
}

const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");

const unboundPaneStates = new Set(["may-have-been-sent", "outcome-unknown"]);

/**
 * Throws a typed failure when any hydrated category is missing, partial or
 * contradicts the owner's acknowledged state.
 */
export function assertSshOwnerHydrationAcknowledged(input: SshOwnerHydrationAck): void {
  const { targetId, snapshot, storage, aliasDescriptor, reconciliation, acknowledgedSnapshot } =
    input;
  if (targetId !== undefined && storage !== undefined) {
    if (storage.writerEpoch.length === 0 || !Number.isSafeInteger(storage.seq) || storage.seq < 0) {
      throw new SshOwnerClientError(
        "hydration-failed",
        "The SSH owner did not acknowledge a writer epoch and sequence; admission stays closed.",
      );
    }
    const durableDisconnect = snapshot.durableDisconnects.some(
      (entry) => entry.targetId === targetId,
    );
    if (durableDisconnect !== storage.disconnected) {
      throw new SshOwnerClientError(
        "hydration-disconnect-mismatch",
        "The durable disconnect set disagrees with the SSH owner's acknowledged store snapshot.",
      );
    }
    const aliasBinding = snapshot.aliasDescriptorBindings.find(
      (entry) => entry.targetId === targetId,
    );
    if (aliasDescriptor !== undefined && aliasBinding === undefined) {
      throw new SshOwnerClientError(
        "hydration-alias-mismatch",
        "The SSH owner resolved an alias descriptor that has no profile-scoped binding.",
      );
    }
    if (
      aliasBinding !== undefined &&
      (aliasDescriptor === undefined || hex(aliasDescriptor) !== aliasBinding.descriptorDigest)
    ) {
      throw new SshOwnerClientError(
        "hydration-alias-mismatch",
        "The SSH owner's alias descriptor does not match the stored binding.",
      );
    }
  }
  if (reconciliation === undefined) {
    // Pinned fixture and legacy owner: the categories are not on the wire, so
    // only the local checks can block admission.
    assertLocalCategories(snapshot);
    return;
  }
  assertReconciled(reconciliation, snapshot, acknowledgedSnapshot);
}

function assertReconciled(
  reconciliation: PickerProofReconciliation,
  snapshot: SshOwnerHydrationSnapshot,
  acknowledgedSnapshot: SshOwnerHydrationSnapshot | undefined,
): void {
  if (!reconciliation.acknowledged) {
    throw new SshOwnerClientError(
      "hydration-failed",
      "The SSH owner did not acknowledge the restart reconciliation; admission stays closed.",
    );
  }
  if (
    reconciliation.retirements !== snapshot.retirementMirror.length ||
    reconciliation.panes !== snapshot.paneBindings.length
  ) {
    throw new SshOwnerClientError(
      "hydration-failed",
      "The acknowledged reconciliation counts do not match the durable rows; a fresh acknowledgement is required.",
    );
  }
  if (acknowledgedSnapshot === undefined) {
    throw new SshOwnerClientError(
      "hydration-failed",
      "The acknowledged reconciliation set is unavailable; admission stays closed.",
    );
  }
  if (
    !Buffer.from(digestSshOwnerReconciliation(snapshot)).equals(
      Buffer.from(digestSshOwnerReconciliation(acknowledgedSnapshot)),
    )
  ) {
    throw new SshOwnerClientError(
      "hydration-failed",
      "The durable rows changed after the acknowledgement; a fresh acknowledgement is required.",
    );
  }
}

/** Legacy fixture gate: an unresolved mirror or unbound pane keeps admission closed. */
function assertLocalCategories(snapshot: SshOwnerHydrationSnapshot): void {
  if (snapshot.retirementMirror.length > 0) {
    throw new SshOwnerClientError(
      "hydration-retirement-unresolved",
      "The retirement mirror still holds unresolved rows; admission stays closed.",
    );
  }
  const unresolvedPane = snapshot.paneBindings.find((entry) => unboundPaneStates.has(entry.state));
  if (unresolvedPane) {
    throw new SshOwnerClientError(
      "hydration-pane-unbound",
      `The direct pane binding ${unresolvedPane.ownerKey} has an unresolved state (${unresolvedPane.state}).`,
    );
  }
}
