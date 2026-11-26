import { decodeMessage } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import {
  isTerminalShellPath,
  readProofTerminal,
  readProofTerminalCwd,
  readProofTerminalReplay,
  readProofTerminalReservation,
  type PickerProofTerminal,
  type PickerProofTerminalReplay,
  type ProofTerminalReservation,
} from "./sshOwnerPickerProof.codec.terminal.ts";
import {
  bytesValue,
  invalid,
  PROOF_TOKEN_BYTES,
  stringValue,
  uintValue,
} from "./sshOwnerPickerProof.codec.wire.ts";

/**
 * Terminal replies: the fixture/production lease records (14, 23, 25, 26) and
 * the W2 T-term production process snapshot (71) and U16 shell inventory (72).
 */
export interface TerminalProcessSnapshotEntry {
  readonly pid: number;
  readonly parentPid: number;
  readonly groupId: number | null;
  readonly foregroundGroupId: number | null;
  readonly command: string;
}

export interface TerminalProcessSnapshot {
  readonly lease: Uint8Array;
  readonly shellPid: number;
  readonly processes: ReadonlyArray<TerminalProcessSnapshotEntry>;
  readonly truncated: boolean;
}

export type TerminalOutcome =
  | { kind: "proofTerminal"; value: PickerProofTerminal }
  | { kind: "proofTerminalCwd"; value: string }
  | { kind: "proofTerminalReplay"; value: PickerProofTerminalReplay }
  | { kind: "proofTerminalReservation"; value: ProofTerminalReservation }
  | { kind: "terminalProcesses"; value: TerminalProcessSnapshot }
  | { kind: "terminalShells"; value: ReadonlyArray<string> };

const MAX_PROCESSES = 512;
const MAX_COMMAND_BYTES = 1024;
const MAX_SHELLS = 64;
const MAX_U32 = 0xffff_ffff;

function readProcess(bytes: Uint8Array): TerminalProcessSnapshotEntry {
  let pid: number | undefined;
  let parentPid: number | undefined;
  let groupId: number | undefined;
  let foregroundGroupId: number | undefined;
  let command: string | undefined;
  decodeMessage(bytes, (field, wire, reader) => {
    if (field === 1 && pid === undefined) pid = uintValue(wire, reader);
    else if (field === 2 && parentPid === undefined) parentPid = uintValue(wire, reader);
    else if (field === 3 && groupId === undefined) groupId = uintValue(wire, reader);
    else if (field === 4 && foregroundGroupId === undefined)
      foregroundGroupId = uintValue(wire, reader);
    else if (field === 5 && command === undefined) command = stringValue(wire, reader);
    else return invalid();
  });
  const value = command ?? "";
  if (
    pid === undefined ||
    pid < 1 ||
    pid > MAX_U32 ||
    (parentPid ?? 0) > MAX_U32 ||
    Buffer.byteLength(value) > MAX_COMMAND_BYTES
  )
    return invalid();
  return {
    pid,
    parentPid: parentPid ?? 0,
    groupId: groupId ?? null,
    foregroundGroupId: foregroundGroupId ?? null,
    command: value,
  };
}

export function readTerminalProcesses(bytes: Uint8Array): TerminalProcessSnapshot {
  let lease: Uint8Array | undefined;
  let shellPid: number | undefined;
  let truncated: boolean | undefined;
  const processes: TerminalProcessSnapshotEntry[] = [];
  decodeMessage(bytes, (field, wire, reader) => {
    if (field === 1 && lease === undefined) lease = bytesValue(wire, reader);
    else if (field === 2 && shellPid === undefined) shellPid = uintValue(wire, reader);
    else if (field === 3 && processes.length < MAX_PROCESSES)
      processes.push(readProcess(bytesValue(wire, reader)));
    else if (field === 4 && truncated === undefined) truncated = uintValue(wire, reader) === 1;
    else return invalid();
  });
  if (lease?.length !== PROOF_TOKEN_BYTES || shellPid === undefined || shellPid < 2)
    return invalid();
  // The owner reports the shell first when it is still present.
  if (processes.length > 0 && processes[0]!.pid !== shellPid) return invalid();
  return { lease, shellPid, processes, truncated: truncated ?? false };
}

export function readTerminalShells(bytes: Uint8Array): ReadonlyArray<string> {
  const paths: string[] = [];
  decodeMessage(bytes, (field, wire, reader) => {
    if (field !== 1 || paths.length >= MAX_SHELLS) return invalid();
    const path = stringValue(wire, reader);
    if (!isTerminalShellPath(path) || paths.includes(path)) return invalid();
    paths.push(path);
  });
  return paths;
}

export function readTerminalOutcome(field: number, bytes: Uint8Array): TerminalOutcome {
  switch (field) {
    case 14:
      return { kind: "proofTerminal", value: readProofTerminal(bytes) };
    case 23:
      return { kind: "proofTerminalReservation", value: readProofTerminalReservation(bytes) };
    case 25:
      return { kind: "proofTerminalReplay", value: readProofTerminalReplay(bytes) };
    case 26:
      return { kind: "proofTerminalCwd", value: readProofTerminalCwd(bytes) };
    case 71:
      return { kind: "terminalProcesses", value: readTerminalProcesses(bytes) };
    case 72:
      return { kind: "terminalShells", value: readTerminalShells(bytes) };
    default:
      return invalid();
  }
}
