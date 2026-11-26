import { decodeMessage, WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import {
  bytesValue,
  invalid,
  PickerProofOwnerError,
  uintValue,
} from "./sshOwnerPickerProof.codec.wire.ts";
import {
  isWorkspaceWriteContents,
  validRelativeOperand,
  writeWorkspaceRoot,
} from "./sshOwnerPickerProof.codec.workspace.ts";

const MAX_BODY_BYTES = 512 * 1024;
const SHA256_BYTES = 32;
const LEASE_BYTES = 40;
const PRESENT_BODY_SIZE_TAG = 6 << 3;

export interface GuardedWriteBinding {
  readonly operationId: string;
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly expectedSha256: Uint8Array;
  readonly attemptedSha256: Uint8Array;
  readonly bodyBytes: number;
}

export type GuardedWriteOperation = { readonly binding: GuardedWriteBinding } & (
  | { readonly kind: "proofGuardedWriteBegin" }
  | {
      readonly kind: "proofGuardedWriteChunk";
      readonly lease: Uint8Array;
      readonly offset: number;
      readonly data: Uint8Array;
    }
  | {
      readonly kind:
        | "proofGuardedWriteCommit"
        | "proofGuardedWriteAbort"
        | "proofGuardedWriteApply";
      readonly lease: Uint8Array;
    }
);

export type GuardedWriteStage =
  | { readonly state: "begun"; readonly lease: Uint8Array }
  | { readonly state: "chunkAccepted"; readonly nextOffset: number }
  | { readonly state: "validatedNotDispatched" | "aborted" };

const operationTag = {
  proofGuardedWriteBegin: 55,
  proofGuardedWriteChunk: 56,
  proofGuardedWriteCommit: 57,
  proofGuardedWriteAbort: 58,
  proofGuardedWriteApply: 59,
} as const;

const validSize = (value: number) =>
  Number.isInteger(value) && value >= 0 && value <= MAX_BODY_BYTES;
const validDigest = (value: Uint8Array) =>
  value instanceof Uint8Array && value.byteLength === SHA256_BYTES;
const invalidOperands = (): never => {
  throw new PickerProofOwnerError("invalidOperands");
};

export function writeGuardedWriteOperation(
  writer: WireWriter,
  operation: GuardedWriteOperation,
): void {
  const binding = new WireWriter();
  const { operationId, relativePath, expectedSha256, attemptedSha256, bodyBytes } =
    operation.binding;
  if (
    !operationId ||
    Buffer.byteLength(operationId) > 128 ||
    operationId.includes("\0") ||
    /[\uD800-\uDFFF]/u.test(operationId) ||
    !validRelativeOperand(relativePath) ||
    !validSize(bodyBytes) ||
    !validDigest(expectedSha256) ||
    !validDigest(attemptedSha256)
  )
    invalidOperands();
  binding.fieldString(1, operationId);
  writeWorkspaceRoot(binding, operation.binding, 2);
  binding.fieldString(3, relativePath);
  binding.fieldBytes(4, expectedSha256);
  binding.fieldBytes(5, attemptedSha256);
  // Proto3 optional distinguishes a present zero (empty edit) from a missing size.
  if (bodyBytes === 0) binding.bytes.push(PRESENT_BODY_SIZE_TAG, 0);
  else binding.fieldUint(6, bodyBytes);

  const operand = new WireWriter();
  operand.fieldRepeatedMessage(1, binding.finish());
  if (operation.kind !== "proofGuardedWriteBegin") {
    if (!(operation.lease instanceof Uint8Array) || operation.lease.length !== LEASE_BYTES)
      invalidOperands();
    operand.fieldBytes(2, operation.lease);
  }
  if (operation.kind === "proofGuardedWriteChunk") {
    const { offset, data } = operation;
    if (
      !validSize(offset) ||
      !isWorkspaceWriteContents(data) ||
      data.length === 0 ||
      offset + data.length > bodyBytes
    )
      invalidOperands();
    operand.fieldUint(3, offset);
    operand.fieldBytes(4, data);
  }
  writer.fieldRepeatedMessage(operationTag[operation.kind], operand.finish());
}

export type GuardedWriteResult =
  | { readonly kind: "saved"; readonly resultSha256: string }
  | { readonly kind: "conflict"; readonly currentSha256: string | null }
  | { readonly kind: "terminal" | "unknown" };

const readDigest = (bytes: Uint8Array): string =>
  validDigest(bytes) ? Buffer.from(bytes).toString("hex") : invalid();

export function readGuardedWriteResult(bytes: Uint8Array): GuardedWriteResult {
  if (bytes.byteLength > 64) return invalid();
  let result: GuardedWriteResult | undefined;
  decodeMessage(bytes, (field, wire, reader) => {
    if (result) return invalid();
    const payload = bytesValue(wire, reader);
    if (field === 1) result = { kind: "saved", resultSha256: readDigest(payload) };
    else if (field === 2) {
      let currentSha256: string | null = null;
      decodeMessage(payload, (field, wire, reader) => {
        if (field !== 1 || currentSha256 !== null) return invalid();
        currentSha256 = readDigest(bytesValue(wire, reader));
      });
      result = { kind: "conflict", currentSha256 };
    } else if ((field === 3 || field === 4) && payload.byteLength === 0)
      result = { kind: field === 3 ? "terminal" : "unknown" };
    else return invalid();
  });
  return result ?? invalid();
}

export function readGuardedWriteStage(bytes: Uint8Array): GuardedWriteStage {
  if (bytes.length > 64) return invalid();
  let stage: GuardedWriteStage | undefined;
  decodeMessage(bytes, (field, wire, reader) => {
    if (stage) return invalid();
    if (field === 1) {
      const lease = bytesValue(wire, reader);
      if (lease.length !== LEASE_BYTES) return invalid();
      stage = { state: "begun", lease };
    } else if (field === 2) {
      const nextOffset = uintValue(wire, reader);
      if (!validSize(nextOffset) || nextOffset === 0) return invalid();
      stage = { state: "chunkAccepted", nextOffset };
    } else if (field === 3 || field === 4) {
      if (bytesValue(wire, reader).length !== 0) return invalid();
      stage = { state: field === 3 ? "validatedNotDispatched" : "aborted" };
    } else return invalid();
  });
  return stage ?? invalid();
}
