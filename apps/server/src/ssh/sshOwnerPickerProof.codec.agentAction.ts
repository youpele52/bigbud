import type { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { invalid, PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

/**
 * Owner-compiled agent management verbs. The owner selects every program,
 * argument, working directory and environment; this module can express only the
 * verb, an operation id and (for install/update) a bounded verified artifact.
 */
export const AGENT_ACTION_KINDS = {
  platformProbe: 1,
  install: 2,
  update: 3,
  remove: 4,
  status: 5,
  start: 6,
  stop: 7,
  wake: 8,
} as const;

export type AgentActionName = keyof typeof AGENT_ACTION_KINDS;

/** Only these two verbs carry artifact bytes, and only on the remote stdin. */
export const AGENT_ARTIFACT_ACTIONS = ["install", "update"] as const;

/** One frame is capped at 64 KiB, so a single-action artifact is bounded. */
export const MAX_AGENT_ACTION_ARTIFACT_BYTES = 48 * 1024;
export const MIN_AGENT_OPERATION_ID_BYTES = 16;
export const MAX_AGENT_OPERATION_ID_BYTES = 64;
const MAX_LABEL_BYTES = 64;
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const SAFE_SHA256 = /^[a-f0-9]{64}$/;

export interface AgentActionArtifact {
  readonly version: string;
  readonly sha256: string;
  readonly size: number;
  readonly targetTriple: string;
  readonly bytes: Uint8Array;
}

export type ProofAgentActionOperation = {
  readonly kind: "proofAgentAction";
  readonly action: AgentActionName;
  readonly operationId: Uint8Array;
  readonly artifact?: AgentActionArtifact;
  /** Read the recorded outcome only; an unknown id is refused, never replayed. */
  readonly reattach?: boolean;
};

export interface AgentActionResult {
  readonly action: AgentActionName;
  readonly operationId: Uint8Array;
  readonly exitCode: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  /** A partial install or a lost acknowledgement: reattach, never replay. */
  readonly outcomeUnknown: boolean;
  /** The recorded outcome of an earlier operation. */
  readonly reattached: boolean;
}

const encoder = new TextEncoder();
// Diagnostics are bounded text; never fail a decode on one stray byte.
const decoder = new TextDecoder("utf-8");

const actionName = (value: number): AgentActionName => {
  for (const [name, number] of Object.entries(AGENT_ACTION_KINDS)) {
    if (number === value) return name as AgentActionName;
  }
  return invalid();
};

const actionValue = (name: string): number => {
  const value = (AGENT_ACTION_KINDS as Record<string, number | undefined>)[name];
  if (value === undefined) throw new PickerProofOwnerError("invalidOperands");
  return value;
};

const takesArtifact = (action: AgentActionName) =>
  (AGENT_ARTIFACT_ACTIONS as readonly string[]).includes(action);

function validateOperationId(operationId: Uint8Array) {
  if (
    operationId.length < MIN_AGENT_OPERATION_ID_BYTES ||
    operationId.length > MAX_AGENT_OPERATION_ID_BYTES
  ) {
    throw new PickerProofOwnerError("invalidOperands");
  }
}

function validateArtifact(artifact: AgentActionArtifact): AgentActionArtifact {
  const versionBytes = encoder.encode(artifact.version).length;
  if (
    versionBytes > MAX_LABEL_BYTES ||
    !SAFE_LABEL.test(artifact.version) ||
    artifact.targetTriple.length > MAX_LABEL_BYTES ||
    !SAFE_LABEL.test(artifact.targetTriple) ||
    !SAFE_SHA256.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size < 1 ||
    artifact.size > MAX_AGENT_ACTION_ARTIFACT_BYTES ||
    artifact.bytes.length !== artifact.size
  ) {
    throw new PickerProofOwnerError("invalidOperands");
  }
  return artifact;
}

export function writeProofAgentAction(
  writer: WireWriter,
  operands: WireWriter,
  operation: ProofAgentActionOperation,
): void {
  const field = actionValue(operation.action);
  validateOperationId(operation.operationId);
  operands.fieldUint(1, field);
  operands.fieldBytes(2, operation.operationId);
  if (takesArtifact(operation.action)) {
    if (!operation.artifact) throw new PickerProofOwnerError("invalidOperands");
    const artifact = validateArtifact(operation.artifact);
    operands.fieldString(3, artifact.version);
    operands.fieldString(4, artifact.sha256);
    operands.fieldUint(5, artifact.size);
    operands.fieldString(6, artifact.targetTriple);
    operands.fieldBytes(7, artifact.bytes);
  } else if (operation.artifact !== undefined) {
    throw new PickerProofOwnerError("invalidOperands");
  }
  if (operation.reattach === true) operands.fieldBool(8, true);
  writer.fieldRepeatedMessage(70, operands.finish());
}

const readBool = (value: number) => {
  if (value !== 0 && value !== 1) return invalid();
  return value === 1;
};

/** Fixed-shape decode with a hand-rolled varint so `int32` sign extension is exact. */
export function readProofAgentActionResult(bytes: Uint8Array): AgentActionResult {
  let offset = 0;
  const raw = (): bigint => {
    let value = 0n;
    for (let shift = 0n; shift <= 63n; shift += 7n) {
      const byte = bytes[offset++];
      if (byte === undefined || (shift === 63n && byte > 1)) return invalid();
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
    }
    return invalid();
  };
  const int32 = () => Number(BigInt.asIntN(32, raw()));
  const length = (): Uint8Array => {
    const size = raw();
    if (size > BigInt(bytes.length - offset)) return invalid();
    const value = bytes.slice(offset, offset + Number(size));
    offset += value.length;
    return value;
  };
  let action: AgentActionName | undefined;
  let operationId: Uint8Array | undefined;
  let exitCode: number | undefined;
  let stdout = "";
  let stderr = "";
  let truncated = false;
  let outcomeUnknown = false;
  let reattached = false;
  while (offset < bytes.length) {
    switch (Number(raw())) {
      case 8:
        if (action !== undefined) return invalid();
        action = actionName(Number(raw()));
        break;
      case 18: {
        if (operationId !== undefined) return invalid();
        const value = length();
        if (
          value.length < MIN_AGENT_OPERATION_ID_BYTES ||
          value.length > MAX_AGENT_OPERATION_ID_BYTES
        )
          return invalid();
        operationId = value;
        break;
      }
      case 24:
        if (exitCode !== undefined) return invalid();
        exitCode = int32();
        break;
      case 34:
        stdout = decoder.decode(length());
        break;
      case 42:
        stderr = decoder.decode(length());
        break;
      case 48:
        truncated = readBool(Number(raw()));
        break;
      case 56:
        outcomeUnknown = readBool(Number(raw()));
        break;
      case 64:
        reattached = readBool(Number(raw()));
        break;
      default:
        return invalid();
    }
  }
  if (action === undefined || operationId === undefined) return invalid();
  return {
    action,
    operationId,
    exitCode,
    stdout,
    stderr,
    truncated,
    outcomeUnknown,
    reattached,
  };
}
