/**
 * U24 production peer client over the owner-wide session (no target bound).
 * Validates operands locally and accepts only the matching reply kind.
 *
 * @module sshOwnerPickerProof.client.peerProduction
 */
import type { PickerProofOperation } from "./sshOwnerPickerProof.codec.ts";
import type { Outcome } from "./sshOwnerPickerProof.codec.outcome.ts";
import type {
  PeerPin,
  PeerProductionCoordinatorKey,
  PeerProductionHostKey,
  PeerRelayState,
} from "./sshOwnerPickerProof.codec.peerProduction.ts";
import { invalid } from "./sshOwnerPickerProof.codec.wire.ts";

export interface PickerProofPeerProductionClient {
  /** Owner-wide coordinator key: provisioned once, public metadata only. */
  ensureCoordinatorKey(): Promise<PeerProductionCoordinatorKey>;
  /** The presented key plus a one-time challenge; nothing is saved. */
  inspectHostKey(host: string, port: number): Promise<PeerProductionHostKey>;
  /** Consume one challenge and write (or replace) the owner's pin for this pairing. */
  approvePin(challenge: Uint8Array, pairingId: string, user: string): Promise<PeerPin>;
  revokePin(pairingId: string): Promise<PeerPin>;
  openRelay(lease: Uint8Array, pairingId: string): Promise<PeerRelayState>;
  relayStatus(lease: Uint8Array): Promise<PeerRelayState>;
  closeRelay(lease: Uint8Array): Promise<PeerRelayState>;
}

type Execute = (operation: PickerProofOperation) => Promise<Outcome>;

const copy = (value: Uint8Array) => Uint8Array.from(value);

export function makePickerProofPeerProductionClient(
  execute: Execute,
): PickerProofPeerProductionClient {
  interface Values {
    readonly peerCoordinatorKey: PeerProductionCoordinatorKey;
    readonly peerHostKey: PeerProductionHostKey;
    readonly peerPin: PeerPin;
    readonly peerRelay: PeerRelayState;
  }
  const expect = async <K extends keyof Values>(
    operation: PickerProofOperation,
    kind: K,
  ): Promise<Values[K]> => {
    const outcome = await execute(operation);
    return outcome.kind === kind ? ((outcome as { value: unknown }).value as Values[K]) : invalid();
  };
  return {
    ensureCoordinatorKey: () => expect({ kind: "ensurePeerCoordinatorKey" }, "peerCoordinatorKey"),
    inspectHostKey: (host, port) =>
      expect({ kind: "inspectPeerHostKey", host, port }, "peerHostKey"),
    approvePin: (challenge, pairingId, user) =>
      expect({ kind: "approvePeerPin", challenge: copy(challenge), pairingId, user }, "peerPin"),
    revokePin: (pairingId) => expect({ kind: "revokePeerPin", pairingId }, "peerPin"),
    openRelay: (lease, pairingId) =>
      expect({ kind: "peerRelayOpen", lease: copy(lease), pairingId }, "peerRelay"),
    relayStatus: (lease) => expect({ kind: "peerRelayStatus", lease: copy(lease) }, "peerRelay"),
    closeRelay: (lease) => expect({ kind: "peerRelayClose", lease: copy(lease) }, "peerRelay"),
  };
}
