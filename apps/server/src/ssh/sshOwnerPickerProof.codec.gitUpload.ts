import { decodeMessage, WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import {
  bytesValue,
  invalid,
  PickerProofOwnerError,
  PROOF_TOKEN_BYTES,
  stringValue,
  uintValue,
} from "./sshOwnerPickerProof.codec.wire.ts";

/**
 * U15 production Git upload lease (Request 77–79, Reply 50). Read-only: there is no
 * receive-pack operation. The owner re-validates both paths and selects the command.
 */
export type GitUploadOperation =
  | {
      readonly kind: "gitUploadOpen";
      readonly lease: Uint8Array;
      readonly workspaceRoot: string;
      readonly repositoryPath: string;
    }
  | { readonly kind: "gitUploadStatus" | "gitUploadClose"; readonly lease: Uint8Array };

export type GitUploadState = { readonly lease: Uint8Array } & (
  | { readonly phase: "listening"; readonly socketPath: string }
  | { readonly phase: "exited"; readonly exitCode: number }
  | {
      readonly phase: "streaming" | "closed" | "lost" | "rejected" | "unconfirmed";
    }
);

const MAX_PATH_BYTES = 1024;

/** Absolute, normalized, control-free and bounded; mirrors the owner check. */
export function isExactRemotePath(path: string): boolean {
  if (!path.startsWith("/") || Buffer.byteLength(path) > MAX_PATH_BYTES) return false;
  // oxlint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(path)) return false;
  return !path
    .slice(1)
    .split("/")
    .some((part) => part === "" || part === "." || part === "..");
}

export function gitUploadAdmits(workspaceRoot: string, repositoryPath: string): boolean {
  return (
    isExactRemotePath(workspaceRoot) &&
    isExactRemotePath(repositoryPath) &&
    (repositoryPath === workspaceRoot || repositoryPath.startsWith(`${workspaceRoot}/`))
  );
}

export function writeGitUpload(writer: WireWriter, operation: GitUploadOperation) {
  if (operation.lease.length !== PROOF_TOKEN_BYTES)
    throw new PickerProofOwnerError("invalidOperands");
  const operands = new WireWriter();
  operands.fieldBytes(1, operation.lease);
  if (operation.kind === "gitUploadOpen") {
    if (!gitUploadAdmits(operation.workspaceRoot, operation.repositoryPath))
      throw new PickerProofOwnerError("invalidOperands");
    operands.fieldString(2, operation.workspaceRoot);
    operands.fieldString(3, operation.repositoryPath);
    writer.fieldRepeatedMessage(77, operands.finish());
  } else {
    writer.fieldRepeatedMessage(operation.kind === "gitUploadStatus" ? 78 : 79, operands.finish());
  }
}

const PHASES = {
  2: "streaming",
  4: "closed",
  5: "lost",
  6: "rejected",
  7: "unconfirmed",
} as const;

export function readGitUpload(bytes: Uint8Array): GitUploadState {
  let lease: Uint8Array | undefined;
  let phase: number | undefined;
  let socketPath: string | undefined;
  let exitCode: number | undefined;
  decodeMessage(bytes, (field, wire, reader) => {
    if (field === 1 && lease === undefined) lease = bytesValue(wire, reader);
    else if (field === 2 && phase === undefined) phase = uintValue(wire, reader);
    else if (field === 3 && socketPath === undefined) socketPath = stringValue(wire, reader);
    else if (field === 4 && exitCode === undefined) exitCode = uintValue(wire, reader);
    else return invalid();
  });
  if (lease?.length !== PROOF_TOKEN_BYTES) return invalid();
  if (phase === 1 && socketPath !== undefined && exitCode === undefined) {
    return isExactRemotePath(socketPath) ? { lease, phase: "listening", socketPath } : invalid();
  }
  if (phase === 3 && exitCode !== undefined && exitCode <= 254 && socketPath === undefined)
    return { lease, phase: "exited", exitCode };
  if (socketPath !== undefined || exitCode !== undefined) return invalid();
  const named = phase === undefined ? undefined : PHASES[phase as keyof typeof PHASES];
  return named ? { lease, phase: named } : invalid();
}
