import type { PickerProofHydratedStorage } from "./sshOwnerPickerProof.client.session.types.ts";
import { SshOwnerClientError } from "./sshOwnerProductionClient.errors.ts";
import type { SshOwnerHydrationSnapshot } from "./sshOwnerProductionHydration.ts";

/**
 * Admission gate for the hydration the boot sequence already reads.
 *
 * The owner acknowledges the store snapshot in its handshake (`ProofStorageHydrate`
 * -> `ProofStorageSnapshot` -> `HelloAccepted`); this module proves every durable
 * category the backend read agrees with that acknowledgement before admission.
 *
 * A category the v1 wire does not yet carry into the owner (alias bindings,
 * retirement mirror rows, direct pane bindings) is still verified locally and
 * must not be partially applied: any disagreement is typed-closed.
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
}

const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");

const unboundPaneStates = new Set(["may-have-been-sent", "outcome-unknown"]);

/**
 * Throws a typed failure when any hydrated category is missing, partial or
 * contradicts the owner's acknowledged store state.
 */
export function assertSshOwnerHydrationAcknowledged(input: SshOwnerHydrationAck): void {
  const { targetId, snapshot, storage, aliasDescriptor } = input;
  if (targetId === undefined || storage === undefined) {
    // Multi-target production: no target-wide acknowledgement exists at startup.
    // Each target's writer epoch, sequence and disconnect flag are supplied to
    // the owner before its first network operation (the owner asks, the backend
    // answers from this same store), so only categories that are unresolved
    // regardless of target can block admission here.
    assertUnresolvedCategories(snapshot);
    return;
  }
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
  assertUnresolvedCategories(snapshot);
}

function assertUnresolvedCategories(snapshot: SshOwnerHydrationSnapshot): void {
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
