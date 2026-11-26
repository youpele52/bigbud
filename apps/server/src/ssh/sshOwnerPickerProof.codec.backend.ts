import { decodeMessage, WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { isExactRemotePath } from "./sshOwnerPickerProof.codec.gitUpload.ts";
import {
  readPeerProductionOutcome,
  writePeerProduction,
  type PeerProductionOperation,
  type PeerProductionOutcome,
} from "./sshOwnerPickerProof.codec.peerProduction.ts";
import {
  isAgentControlOperation,
  readAgentControlState,
  writeAgentControl,
  type AgentControlOperation,
  type AgentControlState,
} from "./sshOwnerPickerProof.codec.agentControl.ts";
import {
  bytesValue,
  invalid,
  PickerProofOwnerError,
  PROOF_TOKEN_BYTES,
  stringValue,
  uintValue,
} from "./sshOwnerPickerProof.codec.wire.ts";

/**
 * W2 T-backend production leases (Request 100–105, Reply 61–62; v1.remote_backend.proto).
 * A deployment step names a kind and data operands only; the owner compiles the remote
 * recipe and its deadline. A relay channel names the persisted profile's pinned
 * installation. Bytes travel on the owner-created lease socket, never in a frame.
 */
export const DEPLOYMENT_STEP_KIND = {
  probeHost: 1,
  stageBegin: 2,
  manifestPut: 3,
  setupInputPut: 4,
  archiveFetch: 5,
  archiveUpload: 6,
  publish: 7,
  setup: 8,
  start: 9,
  readCompletion: 10,
  reset: 11,
} as const;
export type DeploymentStepKind = keyof typeof DEPLOYMENT_STEP_KIND;

const SETUP_INPUT = { rustManifest: 1, trustedKeys: 2 } as const;

/** Data operands for one step. The owner refuses any operand outside the kind. */
export interface DeploymentStepOperands {
  readonly kind: DeploymentStepKind;
  readonly requestId?: string;
  readonly home?: string;
  readonly installName?: string;
  readonly archiveSha256?: string;
  readonly manifestSha256?: string;
  readonly url?: string;
  readonly maxBytes?: number;
  readonly setupInput?: keyof typeof SETUP_INPUT;
  readonly inputSha256?: string;
  readonly nodePath?: string;
  readonly entryPath?: string;
  readonly pins?: ReadonlyArray<{ readonly path: string; readonly sha256: string }>;
  readonly authorityId?: string;
  readonly enableBoot?: boolean;
}

export type BackendLeaseOperation =
  | {
      readonly kind: "deploymentStepOpen";
      readonly lease: Uint8Array;
      readonly step: DeploymentStepOperands;
    }
  | { readonly kind: "deploymentStepStatus" | "deploymentStepCancel"; readonly lease: Uint8Array }
  | {
      readonly kind: "clientRelayLeaseOpen";
      readonly lease: Uint8Array;
      readonly nodeBinary: string;
      readonly nodeSha256: string;
      readonly helperEntry: string;
      readonly helperSha256: string;
      readonly authorityId: string;
    }
  | {
      readonly kind: "clientRelayLeaseStatus" | "clientRelayLeaseClose";
      readonly lease: Uint8Array;
    }
  // U24 owner-wide peer enrollment and relay (Request 130–136).
  | PeerProductionOperation
  // U25 remote-agent control leases (Request 140–142).
  | AgentControlOperation;

export type DeploymentStepState = {
  readonly lease: Uint8Array;
  readonly kind: DeploymentStepKind;
  readonly requestId: string;
} & (
  | { readonly phase: "listening"; readonly socketPath: string }
  | {
      readonly phase: "exited";
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly phase: "running" | "cancelled" | "outcomeUnknown" }
);

export type ClientRelayLeaseState = { readonly lease: Uint8Array } & (
  | { readonly phase: "listening"; readonly socketPath: string }
  | { readonly phase: "exited"; readonly exitCode: number }
  | { readonly phase: "streaming" | "closed" | "lost" | "unconfirmed" }
);

const MAX_STREAM_BYTES = 2 * 1024 ** 3;

function lease(writer: WireWriter, value: Uint8Array) {
  if (value.length !== PROOF_TOKEN_BYTES) throw new PickerProofOwnerError("invalidOperands");
  writer.fieldBytes(1, value);
}

function writeStep(operands: WireWriter, step: DeploymentStepOperands) {
  const maxBytes = step.maxBytes ?? 0;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_STREAM_BYTES)
    throw new PickerProofOwnerError("invalidOperands");
  operands.fieldUint(2, DEPLOYMENT_STEP_KIND[step.kind]);
  operands.fieldString(3, step.requestId ?? "");
  operands.fieldString(4, step.home ?? "");
  operands.fieldString(5, step.installName ?? "");
  operands.fieldString(6, step.archiveSha256 ?? "");
  operands.fieldString(7, step.manifestSha256 ?? "");
  operands.fieldString(8, step.url ?? "");
  operands.fieldUint(9, maxBytes);
  operands.fieldUint(10, step.setupInput ? SETUP_INPUT[step.setupInput] : 0);
  operands.fieldString(11, step.inputSha256 ?? "");
  operands.fieldString(12, step.nodePath ?? "");
  operands.fieldString(13, step.entryPath ?? "");
  for (const pin of step.pins ?? []) {
    const encoded = new WireWriter();
    encoded.fieldString(1, pin.path);
    encoded.fieldString(2, pin.sha256);
    operands.fieldRepeatedMessage(14, encoded.finish());
  }
  operands.fieldString(15, step.authorityId ?? "");
  operands.fieldBool(16, step.enableBoot ?? false);
}

const FIELD = {
  deploymentStepOpen: 100,
  deploymentStepStatus: 101,
  deploymentStepCancel: 102,
  clientRelayLeaseOpen: 103,
  clientRelayLeaseStatus: 104,
  clientRelayLeaseClose: 105,
} as const;

const isPeerProduction = (operation: BackendLeaseOperation): operation is PeerProductionOperation =>
  !Object.hasOwn(FIELD, operation.kind) && !isAgentControlOperation(operation);

export function writeBackendLease(writer: WireWriter, operation: BackendLeaseOperation) {
  if (isPeerProduction(operation)) return writePeerProduction(writer, operation);
  if (isAgentControlOperation(operation))
    return writeAgentControl(writer, operation as AgentControlOperation);
  const leaseOperation = operation as Exclude<
    BackendLeaseOperation,
    PeerProductionOperation | AgentControlOperation
  >;
  const operands = new WireWriter();
  lease(operands, leaseOperation.lease);
  if (leaseOperation.kind === "deploymentStepOpen") writeStep(operands, leaseOperation.step);
  else if (leaseOperation.kind === "clientRelayLeaseOpen") {
    if (
      !isExactRemotePath(leaseOperation.nodeBinary) ||
      !isExactRemotePath(leaseOperation.helperEntry)
    )
      throw new PickerProofOwnerError("invalidOperands");
    operands.fieldString(2, leaseOperation.nodeBinary);
    operands.fieldString(3, leaseOperation.nodeSha256);
    operands.fieldString(4, leaseOperation.helperEntry);
    operands.fieldString(5, leaseOperation.helperSha256);
    operands.fieldString(6, leaseOperation.authorityId);
  }
  writer.fieldRepeatedMessage(FIELD[leaseOperation.kind], operands.finish());
}

const KIND_BY_WIRE = Object.fromEntries(
  Object.entries(DEPLOYMENT_STEP_KIND).map(([name, wire]) => [wire, name]),
) as Record<number, DeploymentStepKind | undefined>;

const STEP_PHASES = { 2: "running", 4: "cancelled", 5: "outcomeUnknown" } as const;

export function readDeploymentStep(bytes: Uint8Array): DeploymentStepState {
  const seen = new Set<number>();
  let lease: Uint8Array | undefined;
  let phase: number | undefined;
  let kind: number | undefined;
  let requestId = "";
  let socketPath: string | undefined;
  let exitCode: number | undefined;
  let stdout = "";
  let stderr = "";
  decodeMessage(bytes, (field, wire, reader) => {
    if (seen.has(field)) return invalid();
    seen.add(field);
    if (field === 1) lease = bytesValue(wire, reader);
    else if (field === 2) phase = uintValue(wire, reader);
    else if (field === 3) kind = uintValue(wire, reader);
    else if (field === 4) requestId = stringValue(wire, reader);
    else if (field === 5) socketPath = stringValue(wire, reader);
    else if (field === 6) exitCode = uintValue(wire, reader);
    else if (field === 7) stdout = stringValue(wire, reader);
    else if (field === 8) stderr = stringValue(wire, reader);
    else return invalid();
  });
  const named = kind === undefined ? undefined : KIND_BY_WIRE[kind];
  if (lease?.length !== PROOF_TOKEN_BYTES || !named) return invalid();
  const base = { lease, kind: named, requestId };
  if (phase === 3) {
    if (exitCode === undefined || exitCode > 254 || socketPath !== undefined) return invalid();
    return { ...base, phase: "exited", exitCode, stdout, stderr };
  }
  if (exitCode !== undefined || stdout || stderr) return invalid();
  if (phase === 1)
    return socketPath !== undefined && isExactRemotePath(socketPath)
      ? { ...base, phase: "listening", socketPath }
      : invalid();
  const other = phase === undefined ? undefined : STEP_PHASES[phase as keyof typeof STEP_PHASES];
  return other && socketPath === undefined ? { ...base, phase: other } : invalid();
}

const RELAY_PHASES = { 2: "streaming", 4: "closed", 5: "lost", 6: "unconfirmed" } as const;

export function readClientRelayLease(bytes: Uint8Array): ClientRelayLeaseState {
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
  if (phase === 1 && socketPath !== undefined && exitCode === undefined)
    return isExactRemotePath(socketPath) ? { lease, phase: "listening", socketPath } : invalid();
  if (phase === 3 && exitCode !== undefined && exitCode <= 254 && socketPath === undefined)
    return { lease, phase: "exited", exitCode };
  if (socketPath !== undefined || exitCode !== undefined) return invalid();
  const named = phase === undefined ? undefined : RELAY_PHASES[phase as keyof typeof RELAY_PHASES];
  return named ? { lease, phase: named } : invalid();
}

export type BackendLeaseOutcome =
  | { readonly kind: "deploymentStep"; readonly value: DeploymentStepState }
  | { readonly kind: "clientRelayLease"; readonly value: ClientRelayLeaseState }
  | PeerProductionOutcome
  | { readonly kind: "agentControl"; readonly value: AgentControlState }
  | { readonly kind: "agentProxyLease"; readonly value: ClientRelayLeaseState };

/** Reply 61 (deployment step), 62 (client relay), U24 peer replies 76–79 or U25 reply 81. */
export function readBackendLeaseOutcome(
  field: 61 | 62 | 76 | 77 | 78 | 79 | 81 | 82,
  bytes: Uint8Array,
): BackendLeaseOutcome {
  if (field === 81) return { kind: "agentControl", value: readAgentControlState(bytes) };
  if (field === 82) return { kind: "agentProxyLease", value: readClientRelayLease(bytes) };
  if (field !== 61 && field !== 62) return readPeerProductionOutcome(field, bytes);
  return field === 61
    ? { kind: "deploymentStep", value: readDeploymentStep(bytes) }
    : { kind: "clientRelayLease", value: readClientRelayLease(bytes) };
}
