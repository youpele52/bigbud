import type { PickerProofOperation } from "./sshOwnerPickerProof.codec.ts";
import type { Outcome } from "./sshOwnerPickerProof.codec.outcome.ts";
import type {
  ProviderLeaseScope,
  ProviderLeaseState,
  ProviderVersion,
} from "./sshOwnerPickerProof.codec.providerLease.ts";
import {
  invalid,
  PickerProofOwnerError,
  PROOF_TOKEN_BYTES,
} from "./sshOwnerPickerProof.codec.wire.ts";

/**
 * W2 T-prov: production Pi/Codex provider verbs on one bound target. The owner discovers the
 * executable and compiles the argv; these calls carry only the provider kind and the session.
 * Every verb queues behind an in-flight exchange (leases poll while other targets use the owner).
 */
export interface PickerProofProductionProviderClient {
  /** Bounded `--version` of the discovered executable; arms lease opens of that kind. */
  probeProvider(scope: ProviderLeaseScope): Promise<ProviderVersion>;
  /** Opens one provider session; the listening state names its two private sockets. */
  openProviderLease(lease: Uint8Array, scope: ProviderLeaseScope): Promise<ProviderLeaseState>;
  providerLeaseStatus(lease: Uint8Array): Promise<ProviderLeaseState>;
  closeProviderLease(lease: Uint8Array): Promise<ProviderLeaseState>;
}

type Execute = (operation: PickerProofOperation) => Promise<Outcome>;

const copyLease = (lease: Uint8Array) => {
  if (lease.length !== PROOF_TOKEN_BYTES) throw new PickerProofOwnerError("invalidOperands");
  return Uint8Array.from(lease);
};

export function makePickerProofProductionProviderClient(
  queued: Execute,
): PickerProofProductionProviderClient {
  const lease = async (operation: PickerProofOperation) => {
    const outcome = await queued(operation);
    return outcome.kind === "providerLease" ? outcome.value : invalid();
  };
  return {
    async probeProvider(scope) {
      const outcome = await queued({ kind: "providerProbe", scope: { ...scope } });
      return outcome.kind === "providerVersion" ? outcome.value : invalid();
    },
    openProviderLease: (token, scope) =>
      lease({ kind: "providerLeaseOpen", lease: copyLease(token), scope: { ...scope } }),
    providerLeaseStatus: (token) => lease({ kind: "providerLeaseStatus", lease: copyLease(token) }),
    closeProviderLease: (token) => lease({ kind: "providerLeaseClose", lease: copyLease(token) }),
  };
}
