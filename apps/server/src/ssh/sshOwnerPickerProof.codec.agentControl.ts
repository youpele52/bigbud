import { decodeMessage, WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { isExactRemotePath } from "./sshOwnerPickerProof.codec.gitUpload.ts";
import {
  bytesValue,
  invalid,
  PickerProofOwnerError,
  PROOF_TOKEN_BYTES,
  stringValue,
  uintValue,
} from "./sshOwnerPickerProof.codec.wire.ts";

/**
 * U25 remote-agent control leases (Request 140–142, Reply 81; v1.agent_control.proto). A lease
 * names one kind and data operands only; the owner runs the template generated from the legacy
 * builder. Registry CAS and install upload bytes travel on the owner-made lease socket.
 */
export const AGENT_CONTROL_KIND = {
  controlRoot: 1,
  registryRead: 2,
  registryCas: 3,
  stageFenceRevoke: 4,
  inventory: 5,
  supervisorObserve: 6,
  admissionDeathObserve: 7,
  stateAbsent: 8,
  supervisorShutdown: 9,
  supervisorRestart: 10,
  isolatedLaunch: 11,
  replacementLaunch: 12,
  retirementDelete: 13,
  removal: 14,
  removalResume: 15,
  removalOutcome: 16,
  hostClock: 17,
  orphanDelete: 18,
  backendRuntimeProbe: 19,
  socketLive: 20,
  socketGone: 21,
  runtimeProbe: 22,
  platformProbe: 23,
  readOnlyStatus: 24,
  installUpload: 25,
  placedProbe: 26,
  inboxAdopt: 27,
  identityCheck: 28,
} as const;
export type AgentControlKind = keyof typeof AGENT_CONTROL_KIND;

export const AGENT_OBSERVE_MODE = {
  retirementState: 1,
  retirementExit: 2,
  launchExit: 3,
  raw: 4,
  candidateStartup: 5,
  candidateExit: 6,
  replacementReadiness: 7,
  replacementDeath: 8,
} as const;
export type AgentObserveMode = keyof typeof AGENT_OBSERVE_MODE;

export interface AgentControlRuntime {
  readonly generation: string;
  readonly version: string;
  readonly sha256: string;
  readonly buildDigest: string;
  readonly targetTriple: string;
  readonly binaryPath: string;
  readonly statePath: string;
  readonly socketPath: string;
  readonly logPath: string;
  readonly origin: "managed" | "legacy-external";
}

export interface StreamedIdentity {
  readonly size: number;
  readonly sha256: string;
}

/** Data operands for one kind. The owner refuses any operand outside the kind. */
export interface AgentControlOperands {
  readonly kind: AgentControlKind;
  readonly runtime?: AgentControlRuntime;
  readonly observeMode?: AgentObserveMode;
  readonly attemptId?: string;
  readonly epoch?: string;
  readonly oldAttemptId?: string;
  readonly oldEpoch?: string;
  readonly reservationId?: string;
  readonly fenceId?: string;
  readonly version?: string;
  readonly sha256?: string;
  readonly size?: number;
  readonly binaryPath?: string;
  /** Registry CAS: `null` when no registry is expected. */
  readonly expected?: StreamedIdentity | null;
  readonly next?: StreamedIdentity;
}

export type AgentControlOperation =
  | {
      readonly kind: "agentControlOpen";
      readonly lease: Uint8Array;
      readonly control: AgentControlOperands;
    }
  | { readonly kind: "agentControlStatus" | "agentControlCancel"; readonly lease: Uint8Array }
  /** Installed-agent proxy session for one registry runtime (Request 143–145). */
  | {
      readonly kind: "agentProxyLeaseOpen";
      readonly lease: Uint8Array;
      readonly runtime: AgentControlRuntime;
    }
  | { readonly kind: "agentProxyLeaseStatus" | "agentProxyLeaseClose"; readonly lease: Uint8Array };

export type AgentControlState = {
  readonly lease: Uint8Array;
  readonly kind: AgentControlKind;
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

const FIELD = {
  agentControlOpen: 140,
  agentControlStatus: 141,
  agentControlCancel: 142,
  agentProxyLeaseOpen: 143,
  agentProxyLeaseStatus: 144,
  agentProxyLeaseClose: 145,
} as const;
export const isAgentControlOperation = (operation: { readonly kind: string }) =>
  Object.hasOwn(FIELD, operation.kind);

const uint = (value: number | undefined) => {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new PickerProofOwnerError("invalidOperands");
  return value;
};

function writeRuntime(runtime: AgentControlRuntime): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, runtime.generation);
  writer.fieldString(2, runtime.version);
  writer.fieldString(3, runtime.sha256);
  writer.fieldString(4, runtime.buildDigest);
  writer.fieldString(5, runtime.targetTriple);
  writer.fieldString(6, runtime.binaryPath);
  writer.fieldString(7, runtime.statePath);
  writer.fieldString(8, runtime.socketPath);
  writer.fieldString(9, runtime.logPath);
  writer.fieldUint(10, runtime.origin === "managed" ? 1 : 2);
  return writer.finish();
}

function writeOperands(operands: WireWriter, control: AgentControlOperands) {
  operands.fieldUint(2, AGENT_CONTROL_KIND[control.kind]);
  if (control.runtime) operands.fieldRepeatedMessage(3, writeRuntime(control.runtime));
  operands.fieldUint(4, control.observeMode ? AGENT_OBSERVE_MODE[control.observeMode] : 0);
  operands.fieldString(5, control.attemptId ?? "");
  operands.fieldString(6, control.epoch ?? "");
  operands.fieldString(7, control.oldAttemptId ?? "");
  operands.fieldString(8, control.oldEpoch ?? "");
  operands.fieldString(9, control.reservationId ?? "");
  operands.fieldString(10, control.fenceId ?? "");
  operands.fieldString(11, control.version ?? "");
  operands.fieldString(12, control.sha256 ?? "");
  operands.fieldUint(13, uint(control.size));
  operands.fieldString(14, control.binaryPath ?? "");
  operands.fieldBool(15, Boolean(control.expected));
  operands.fieldUint(16, uint(control.expected?.size));
  operands.fieldString(17, control.expected?.sha256 ?? "");
  operands.fieldUint(18, uint(control.next?.size));
  operands.fieldString(19, control.next?.sha256 ?? "");
}

export function writeAgentControl(writer: WireWriter, operation: AgentControlOperation) {
  const operands = new WireWriter();
  if (operation.lease.length !== PROOF_TOKEN_BYTES)
    throw new PickerProofOwnerError("invalidOperands");
  operands.fieldBytes(1, operation.lease);
  if (operation.kind === "agentControlOpen") writeOperands(operands, operation.control);
  if (operation.kind === "agentProxyLeaseOpen")
    operands.fieldRepeatedMessage(2, writeRuntime(operation.runtime));
  writer.fieldRepeatedMessage(FIELD[operation.kind], operands.finish());
}

const KIND_BY_WIRE = Object.fromEntries(
  Object.entries(AGENT_CONTROL_KIND).map(([name, wire]) => [wire, name]),
) as Record<number, AgentControlKind | undefined>;
const PHASES = { 2: "running", 4: "cancelled", 5: "outcomeUnknown" } as const;

/** Reply 81. */
export function readAgentControlState(bytes: Uint8Array): AgentControlState {
  const seen = new Set<number>();
  let lease: Uint8Array | undefined;
  let phase: number | undefined;
  let kind: number | undefined;
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
    else if (field === 4) socketPath = stringValue(wire, reader);
    else if (field === 5) exitCode = uintValue(wire, reader);
    else if (field === 6) stdout = stringValue(wire, reader);
    else if (field === 7) stderr = stringValue(wire, reader);
    else return invalid();
  });
  const named = kind === undefined ? undefined : KIND_BY_WIRE[kind];
  if (lease?.length !== PROOF_TOKEN_BYTES || !named) return invalid();
  const base = { lease, kind: named };
  if (phase === 3) {
    if (exitCode === undefined || exitCode > 254 || socketPath !== undefined) return invalid();
    return { ...base, phase: "exited", exitCode, stdout, stderr };
  }
  if (exitCode !== undefined || stdout || stderr) return invalid();
  if (phase === 1)
    return socketPath !== undefined && isExactRemotePath(socketPath)
      ? { ...base, phase: "listening", socketPath }
      : invalid();
  const other = phase === undefined ? undefined : PHASES[phase as keyof typeof PHASES];
  return other && socketPath === undefined ? { ...base, phase: other } : invalid();
}
