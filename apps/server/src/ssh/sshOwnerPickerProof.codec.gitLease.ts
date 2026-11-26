import type { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import {
  readGitReceive,
  writeGitReceive,
  type GitReceiveOperation,
  type GitReceiveState,
} from "./sshOwnerPickerProof.codec.gitReceive.ts";
import {
  readGitUpload,
  writeGitUpload,
  type GitUploadOperation,
  type GitUploadState,
} from "./sshOwnerPickerProof.codec.gitUpload.ts";

/** U15 production Git leases: upload (Request 77–79, Reply 50) and receive (110–112, 66). */
export type GitLeaseOperation = GitUploadOperation | GitReceiveOperation;

export type GitLeaseOutcome =
  | { readonly kind: "gitUpload"; readonly value: GitUploadState }
  | { readonly kind: "gitReceive"; readonly value: GitReceiveState };

function isReceive(operation: GitLeaseOperation): operation is GitReceiveOperation {
  return (
    operation.kind === "gitReceiveOpen" ||
    operation.kind === "gitReceiveStatus" ||
    operation.kind === "gitReceiveClose"
  );
}

export function writeGitLease(writer: WireWriter, operation: GitLeaseOperation) {
  if (isReceive(operation)) writeGitReceive(writer, operation);
  else writeGitUpload(writer, operation);
}

export function readGitLeaseOutcome(field: 50 | 66, bytes: Uint8Array): GitLeaseOutcome {
  return field === 50
    ? { kind: "gitUpload", value: readGitUpload(bytes) }
    : { kind: "gitReceive", value: readGitReceive(bytes) };
}
