import type { PickerProofHydratedStorage } from "./sshOwnerPickerProof.client.session.types.ts";
import type { hydratePickerProofTarget } from "./sshOwnerPickerProof.storage.ts";
import type { SshOwnerHydrationSnapshot } from "./sshOwnerProductionHydration.ts";

/** The empty reconciliation snapshot a production handshake answers with. */
export const EMPTY_SNAPSHOT: SshOwnerHydrationSnapshot = {
  durableDisconnects: [],
  aliasDescriptorBindings: [],
  retirementMirror: [],
  paneBindings: [],
};

/** Project retained storage facts for the owner without exposing native state. */
export function hydrated(
  snapshot: Awaited<ReturnType<typeof hydratePickerProofTarget>> | undefined,
): PickerProofHydratedStorage | undefined {
  if (snapshot === undefined) return undefined;
  return {
    writerEpoch: snapshot.writerEpoch,
    seq: snapshot.seq,
    disconnected: snapshot.disconnected,
  };
}
