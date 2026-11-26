import type { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import {
  isProofTerminalOperation,
  writeProofTerminalOperation,
  type ProofTerminalOperation,
} from "./sshOwnerPickerProof.codec.terminal.ts";
import {
  readTerminalOutcome,
  type TerminalOutcome,
} from "./sshOwnerPickerProof.codec.terminalOutcome.ts";
import {
  isWorkspaceEntryOperation,
  readWorkspaceEntryOutcome,
  writeWorkspaceEntryOperation,
  type WorkspaceEntryOperation,
  type WorkspaceEntryOutcome,
} from "./sshOwnerPickerProof.codec.workspaceEntry.ts";
import {
  isSystemStatusOperation,
  readSystemStatusOutcome,
  SYSTEM_STATUS_REPLY_FIELD,
  writeSystemStatusOperation,
  type SystemStatusOperation,
  type SystemStatusOutcome,
} from "./sshOwnerPickerProof.codec.systemStatus.ts";

/**
 * W2 T-term / T-files lane codec: every terminal verb and the session-FS entry
 * verbs (plus the W7 system stats sample, which runs on the same target master)
 * share one encode guard and one reply reader, so the shared codec only routes
 * to this lane.
 */
export type LaneOperation =
  | ProofTerminalOperation
  | WorkspaceEntryOperation
  | SystemStatusOperation;
export type LaneOutcome = TerminalOutcome | WorkspaceEntryOutcome | SystemStatusOutcome;

export function isLaneOperation<O extends { readonly kind: string }>(
  operation: O,
): operation is Extract<O, LaneOperation> {
  return (
    isProofTerminalOperation(operation) ||
    isWorkspaceEntryOperation(operation) ||
    isSystemStatusOperation(operation)
  );
}

export function writeLaneOperation(
  writer: WireWriter,
  operands: WireWriter,
  operation: LaneOperation,
) {
  if (isWorkspaceEntryOperation(operation)) return writeWorkspaceEntryOperation(writer, operation);
  if (isSystemStatusOperation(operation)) return writeSystemStatusOperation(writer);
  return writeProofTerminalOperation(writer, operands, operation);
}

export function readLaneOutcome(field: number, bytes: Uint8Array): LaneOutcome {
  if (field === SYSTEM_STATUS_REPLY_FIELD) return readSystemStatusOutcome(bytes);
  return field === 73 || field === 74
    ? readWorkspaceEntryOutcome(field, bytes)
    : readTerminalOutcome(field, bytes);
}
