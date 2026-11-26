import type { PickerProofOperation } from "./sshOwnerPickerProof.codec.ts";
import type { Outcome } from "./sshOwnerPickerProof.codec.outcome.ts";
import type {
  CredentialKind,
  CredentialState,
  CredentialUnlockLease,
} from "./sshOwnerPickerProof.codec.credential.ts";
import {
  invalid,
  PickerProofOwnerError,
  PROOF_TOKEN_BYTES,
} from "./sshOwnerPickerProof.codec.wire.ts";

/**
 * In-app password and key-passphrase verbs on one bound target (v1.credential.proto). No
 * secret is an operand: the caller writes it to the socket `openCredentialUnlock` returns,
 * then commits. Every verb queues behind an in-flight exchange.
 */
export interface PickerProofProductionCredentialClient {
  inspectCredential(): Promise<CredentialState>;
  openCredentialUnlock(
    lease: Uint8Array,
    credential: Exclude<CredentialKind, "none">,
  ): Promise<CredentialUnlockLease>;
  commitCredentialUnlock(lease: Uint8Array): Promise<CredentialState>;
  lockCredential(): Promise<CredentialState>;
}

type Execute = (operation: PickerProofOperation) => Promise<Outcome>;

const copyLease = (lease: Uint8Array) => {
  if (lease.length !== PROOF_TOKEN_BYTES) throw new PickerProofOwnerError("invalidOperands");
  return Uint8Array.from(lease);
};

export function makePickerProofProductionCredentialClient(
  queued: Execute,
): PickerProofProductionCredentialClient {
  const state = async (operation: PickerProofOperation) => {
    const outcome = await queued(operation);
    return outcome.kind === "credentialState" ? outcome.value : invalid();
  };
  return {
    inspectCredential: () => state({ kind: "inspectCredential" }),
    async openCredentialUnlock(lease, credential) {
      const outcome = await queued({
        kind: "credentialUnlockOpen",
        lease: copyLease(lease),
        credential,
      });
      return outcome.kind === "credentialUnlockLease" ? outcome.value : invalid();
    },
    commitCredentialUnlock: (lease) =>
      state({ kind: "credentialUnlockCommit", lease: copyLease(lease) }),
    lockCredential: () => state({ kind: "credentialLock" }),
  };
}
