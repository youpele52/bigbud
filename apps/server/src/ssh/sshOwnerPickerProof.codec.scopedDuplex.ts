import { posix } from "node:path";
import type { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

export interface PickerProofPeerFixture {
  readonly pairingId: string;
  readonly grantId: string;
  readonly workerAuthorityId: string;
  readonly hostKeyFingerprint: string;
  readonly coordinatorKeyFingerprint: string;
}

export interface PickerProofGitAdvertisementFixture {
  readonly repositoryPath: string;
  readonly sourceRef: string;
  readonly destinationRef: string;
  readonly sourceOid: string;
}

export interface PickerProofGitUploadFixture {
  readonly repositoryPath: string;
}

export function validateProofGitUpload({ repositoryPath }: PickerProofGitUploadFixture) {
  if (!/^\/tmp\/bigbud-picker-linux-[A-Za-z0-9]{1,64}\/upload\.git$/.test(repositoryPath))
    throw new PickerProofOwnerError("invalidOperands");
  return { repositoryPath };
}

export type ScopedDuplexOpen =
  | (PickerProofGitUploadFixture & { readonly kind: "openProofGitUpload" })
  | (PickerProofPeerFixture & { readonly kind: "openProofPeerRelay" })
  | (PickerProofGitAdvertisementFixture & { readonly kind: "openProofGitAdvertisement" });

const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ref = /^refs\/heads\/[A-Za-z0-9._/-]+$/;

export function validateProofPeerFixture({
  pairingId,
  grantId,
  workerAuthorityId,
  hostKeyFingerprint,
  coordinatorKeyFingerprint,
}: PickerProofPeerFixture): PickerProofPeerFixture {
  if (
    !id.test(pairingId) ||
    !id.test(grantId) ||
    !/^[0-9a-f]{32}$/.test(workerAuthorityId) ||
    !/^SHA256:[A-Za-z0-9+/]{43}$/.test(hostKeyFingerprint) ||
    !/^sha256:[0-9a-f]{64}$/.test(coordinatorKeyFingerprint)
  ) {
    throw new PickerProofOwnerError("invalidOperands");
  }
  return { pairingId, grantId, workerAuthorityId, hostKeyFingerprint, coordinatorKeyFingerprint };
}

export function validateProofGitAdvertisement({
  repositoryPath,
  sourceRef,
  destinationRef,
  sourceOid,
}: PickerProofGitAdvertisementFixture): PickerProofGitAdvertisementFixture {
  if (
    !posix.isAbsolute(repositoryPath) ||
    repositoryPath.includes("\0") ||
    Buffer.byteLength(repositoryPath) > 4095 ||
    !ref.test(sourceRef) ||
    !ref.test(destinationRef) ||
    Buffer.byteLength(sourceRef) > 255 ||
    Buffer.byteLength(destinationRef) > 255 ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sourceOid)
  ) {
    throw new PickerProofOwnerError("invalidOperands");
  }
  return { repositoryPath, sourceRef, destinationRef, sourceOid };
}

export function writeScopedDuplex(operands: WireWriter, operation: ScopedDuplexOpen) {
  if (operation.kind === "openProofGitUpload") {
    operands.fieldString(1, validateProofGitUpload(operation).repositoryPath);
    return 45;
  }
  if (operation.kind === "openProofPeerRelay") {
    const { pairingId, grantId, workerAuthorityId, hostKeyFingerprint, coordinatorKeyFingerprint } =
      validateProofPeerFixture(operation);
    operands.fieldString(1, pairingId);
    operands.fieldString(2, grantId);
    operands.fieldString(3, workerAuthorityId);
    operands.fieldString(4, hostKeyFingerprint);
    operands.fieldString(5, coordinatorKeyFingerprint);
    return 42;
  }
  const { repositoryPath, sourceRef, destinationRef, sourceOid } =
    validateProofGitAdvertisement(operation);
  operands.fieldString(1, repositoryPath);
  operands.fieldString(2, sourceRef);
  operands.fieldString(3, destinationRef);
  operands.fieldString(4, sourceOid);
  return 43;
}
