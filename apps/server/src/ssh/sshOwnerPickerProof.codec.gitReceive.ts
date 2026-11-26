import { decodeMessage, WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { gitUploadAdmits, isExactRemotePath } from "./sshOwnerPickerProof.codec.gitUpload.ts";
import {
  bytesValue,
  invalid,
  PickerProofOwnerError,
  PROOF_TOKEN_BYTES,
  stringValue,
  uintValue,
} from "./sshOwnerPickerProof.codec.wire.ts";

/**
 * U15 production Git receive lease (Request 110–112, Reply 66). The approval fixes the one
 * update the owner may forward: `<expectedOldOid> <sourceOid> <destinationRef>`. Stale,
 * refused and rejected outcomes are settled receipts on the state, not error codes.
 */
export interface GitReceiveApproval {
  readonly workspaceRoot: string;
  readonly repositoryPath: string;
  readonly destinationRef: string;
  readonly expectedOldOid: string;
  readonly sourceOid: string;
}

export type GitReceiveOperation =
  | ({ readonly kind: "gitReceiveOpen"; readonly lease: Uint8Array } & GitReceiveApproval)
  | { readonly kind: "gitReceiveStatus" | "gitReceiveClose"; readonly lease: Uint8Array };

export type GitReceiveReceipt = "accepted" | "unchanged" | "rejected" | "stale" | "refused";

export type GitReceiveState = { readonly lease: Uint8Array } & (
  | { readonly phase: "listening"; readonly socketPath: string }
  | { readonly phase: "finished"; readonly receipt: GitReceiveReceipt }
  | {
      readonly phase: "streaming" | "closed" | "lost" | "rejected" | "unconfirmed";
    }
);

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const BRANCH_PART = /^[A-Za-z0-9_.-]+$/u;

function isObjectId(oid: string): boolean {
  return OID.test(oid) && /[1-9a-f]/u.test(oid);
}

/** Mirrors the owner's receive gate: a `refs/heads/` branch, two same-width OIDs (old may be zero). */
export function gitReceiveApprovalAdmits(approval: GitReceiveApproval): boolean {
  const name = approval.destinationRef.startsWith("refs/heads/")
    ? approval.destinationRef.slice("refs/heads/".length)
    : "";
  return (
    gitUploadAdmits(approval.workspaceRoot, approval.repositoryPath) &&
    approval.destinationRef.length <= 255 &&
    name.length > 0 &&
    !name.startsWith("-") &&
    !name.includes("..") &&
    name
      .split("/")
      .every(
        (part) =>
          BRANCH_PART.test(part) &&
          !part.startsWith(".") &&
          !part.endsWith(".") &&
          !part.endsWith(".lock"),
      ) &&
    // An all-zero expected old OID is a first publish: the ref must be absent on the target.
    (isObjectId(approval.expectedOldOid) || /^0+$/u.test(approval.expectedOldOid)) &&
    OID.test(approval.expectedOldOid) &&
    isObjectId(approval.sourceOid) &&
    approval.expectedOldOid.length === approval.sourceOid.length
  );
}

export function writeGitReceive(writer: WireWriter, operation: GitReceiveOperation) {
  if (operation.lease.length !== PROOF_TOKEN_BYTES)
    throw new PickerProofOwnerError("invalidOperands");
  const operands = new WireWriter();
  operands.fieldBytes(1, operation.lease);
  if (operation.kind === "gitReceiveOpen") {
    if (!gitReceiveApprovalAdmits(operation)) throw new PickerProofOwnerError("invalidOperands");
    operands.fieldString(2, operation.workspaceRoot);
    operands.fieldString(3, operation.repositoryPath);
    operands.fieldString(4, operation.destinationRef);
    operands.fieldString(5, operation.expectedOldOid);
    operands.fieldString(6, operation.sourceOid);
    writer.fieldRepeatedMessage(110, operands.finish());
  } else {
    writer.fieldRepeatedMessage(
      operation.kind === "gitReceiveStatus" ? 111 : 112,
      operands.finish(),
    );
  }
}

const PHASES = {
  2: "streaming",
  4: "closed",
  5: "lost",
  6: "rejected",
  7: "unconfirmed",
} as const;
const RECEIPTS = {
  1: "accepted",
  2: "unchanged",
  3: "rejected",
  4: "stale",
  5: "refused",
} as const;

export function readGitReceive(bytes: Uint8Array): GitReceiveState {
  let lease: Uint8Array | undefined;
  let phase: number | undefined;
  let socketPath: string | undefined;
  let receipt: number | undefined;
  decodeMessage(bytes, (field, wire, reader) => {
    if (field === 1 && lease === undefined) lease = bytesValue(wire, reader);
    else if (field === 2 && phase === undefined) phase = uintValue(wire, reader);
    else if (field === 3 && socketPath === undefined) socketPath = stringValue(wire, reader);
    else if (field === 4 && receipt === undefined) receipt = uintValue(wire, reader);
    else return invalid();
  });
  if (lease?.length !== PROOF_TOKEN_BYTES) return invalid();
  if (phase === 1 && socketPath !== undefined && !receipt) {
    return isExactRemotePath(socketPath) ? { lease, phase: "listening", socketPath } : invalid();
  }
  if (socketPath !== undefined) return invalid();
  if (phase === 3) {
    const named = receipt === undefined ? undefined : RECEIPTS[receipt as keyof typeof RECEIPTS];
    return named ? { lease, phase: "finished", receipt: named } : invalid();
  }
  if (receipt) return invalid();
  const named = phase === undefined ? undefined : PHASES[phase as keyof typeof PHASES];
  return named ? { lease, phase: named } : invalid();
}
