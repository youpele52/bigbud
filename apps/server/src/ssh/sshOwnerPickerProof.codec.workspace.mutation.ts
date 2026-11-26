import { decodeMessage, WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import {
  bytesValue,
  invalid,
  PickerProofOwnerError,
  uintValue,
} from "./sshOwnerPickerProof.codec.wire.ts";
import { validRelativeOperand, writeWorkspaceRoot } from "./sshOwnerPickerProof.codec.workspace.ts";

export const MAX_WORKSPACE_STAGED_WRITE_BYTES = 512 * 1024;
export const MAX_WORKSPACE_WRITE_CHUNK_BYTES = 48 * 1024;
const MAX_OPERATION_ID_BYTES = 128;

interface WorkspaceRoot {
  readonly workspaceRoot: string;
}

interface WorkspaceEntry extends WorkspaceRoot {
  readonly relativePath: string;
}

export interface ProofWorkspaceCreateDirectoryOperation extends WorkspaceEntry {
  readonly kind: "proofWorkspaceCreateDirectory";
}

export interface ProofWorkspaceDeleteEntryOperation extends WorkspaceEntry {
  readonly kind: "proofWorkspaceDeleteEntry";
  readonly expectedDirectory: boolean;
}

export interface ProofWorkspaceWriteBinding {
  readonly operationId: string;
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly bodyBytes: number;
}

export type ProofWorkspaceWriteStageOperation =
  | {
      readonly kind: "proofWorkspaceWriteBegin";
      readonly binding: ProofWorkspaceWriteBinding;
    }
  | {
      readonly kind: "proofWorkspaceWriteChunk";
      readonly binding: ProofWorkspaceWriteBinding;
      readonly lease: Uint8Array;
      readonly offset: number;
      readonly data: Uint8Array;
    }
  | {
      readonly kind: "proofWorkspaceWriteCommit" | "proofWorkspaceWriteAbort";
      readonly binding: ProofWorkspaceWriteBinding;
      readonly lease: Uint8Array;
    };

const validOperationId = (value: string) =>
  value.length > 0 && !value.includes("\0") && Buffer.byteLength(value) <= MAX_OPERATION_ID_BYTES;

export function writeWorkspaceCreateDirectory(
  writer: WireWriter,
  operation: ProofWorkspaceCreateDirectoryOperation,
) {
  writeEntry(writer, operation);
}

export function writeWorkspaceDeleteEntry(
  writer: WireWriter,
  operation: ProofWorkspaceDeleteEntryOperation,
) {
  writeEntry(writer, operation);
  writer.fieldUint(3, operation.expectedDirectory ? 1 : 0);
}

function writeEntry(writer: WireWriter, operation: WorkspaceEntry) {
  if (!validRelativeOperand(operation.relativePath)) {
    throw new PickerProofOwnerError("invalidOperands");
  }
  writeWorkspaceRoot(writer, operation);
  writer.fieldString(2, operation.relativePath);
}

export function writeWorkspaceWriteStage(
  writer: WireWriter,
  operation: ProofWorkspaceWriteStageOperation,
) {
  const { binding } = operation;
  if (
    !validOperationId(binding.operationId) ||
    !validRelativeOperand(binding.relativePath) ||
    !Number.isSafeInteger(binding.bodyBytes) ||
    binding.bodyBytes < 0 ||
    binding.bodyBytes > MAX_WORKSPACE_STAGED_WRITE_BYTES
  ) {
    throw new PickerProofOwnerError("invalidOperands");
  }
  const message = new WireWriter();
  message.fieldString(1, binding.operationId);
  writeWorkspaceRoot(message, binding, 2);
  message.fieldString(3, binding.relativePath);
  message.fieldUint(4, binding.bodyBytes);
  writer.fieldRepeatedMessage(1, message.finish());
  if (operation.kind === "proofWorkspaceWriteBegin") return;
  if (operation.lease.length !== 40) throw new PickerProofOwnerError("invalidOperands");
  writer.fieldBytes(2, operation.lease);
  if (operation.kind === "proofWorkspaceWriteChunk") {
    if (
      operation.data.length === 0 ||
      operation.data.length > MAX_WORKSPACE_WRITE_CHUNK_BYTES ||
      operation.offset < 0 ||
      operation.offset > MAX_WORKSPACE_STAGED_WRITE_BYTES
    ) {
      throw new PickerProofOwnerError("invalidOperands");
    }
    writer.fieldUint(3, operation.offset);
    writer.fieldBytes(4, operation.data);
  }
}

export type PickerProofWorkspaceEntryMutation =
  | "created"
  | "alreadyExists"
  | "deleted"
  | "notFound";

export function readWorkspaceEntryMutation(bytes: Uint8Array): PickerProofWorkspaceEntryMutation {
  // Canonical empty oneof arms: tag plus zero length.
  if (bytes.length !== 2 || bytes[1] !== 0) return invalid();
  switch (bytes[0]) {
    case 0x0a:
      return "created";
    case 0x12:
      return "alreadyExists";
    case 0x1a:
      return "deleted";
    case 0x22:
      return "notFound";
    default:
      return invalid();
  }
}

export type PickerProofWorkspaceWriteStage =
  | { readonly kind: "begun"; readonly lease: Uint8Array }
  | { readonly kind: "chunkAccepted"; readonly nextOffset: number }
  | { readonly kind: "written" }
  | { readonly kind: "aborted" };

export function readWorkspaceWriteStage(bytes: Uint8Array): PickerProofWorkspaceWriteStage {
  let outcome: PickerProofWorkspaceWriteStage | undefined;
  const set = (value: PickerProofWorkspaceWriteStage) => {
    if (outcome !== undefined) return invalid();
    outcome = value;
  };
  decodeMessage(bytes, (number, wire, reader) => {
    if (number === 1) {
      const lease = bytesValue(wire, reader);
      if (lease.length !== 40) return invalid();
      set({ kind: "begun", lease });
    } else if (number === 2) {
      set({ kind: "chunkAccepted", nextOffset: uintValue(wire, reader) });
    } else if (number === 3) {
      if (bytesValue(wire, reader).length !== 0) return invalid();
      set({ kind: "written" });
    } else if (number === 4) {
      if (bytesValue(wire, reader).length !== 0) return invalid();
      set({ kind: "aborted" });
    } else reader.skip(wire);
  });
  return outcome ?? invalid();
}
