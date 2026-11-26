import type { Outcome } from "./sshOwnerPickerProof.codec.outcome.ts";
import type {
  PickerProofPrepareTerminalInput,
  PickerProofTerminal,
  PickerProofTerminalReplay,
  ProofTerminalOperation,
} from "./sshOwnerPickerProof.codec.terminal.ts";
import type { TerminalProcessSnapshot } from "./sshOwnerPickerProof.codec.terminalOutcome.ts";
import {
  invalid,
  PickerProofOwnerError,
  PROOF_TOKEN_BYTES,
} from "./sshOwnerPickerProof.codec.wire.ts";

export interface PickerProofTerminalReservation {
  readonly lease: Uint8Array;
  readonly ownerEpoch: Uint8Array;
  readonly targetGeneration: Uint8Array;
}

export interface PickerProofTerminalClient {
  probeProofTerminalCwd(cwd: string): Promise<string>;
  openProofTerminal(): Promise<PickerProofTerminal>;
  prepareProofTerminal(
    input: PickerProofPrepareTerminalInput,
  ): Promise<PickerProofTerminalReservation>;
  openReservedProofTerminal(lease: Uint8Array): Promise<PickerProofTerminal>;
  cancelProofTerminalReservation(lease: Uint8Array): Promise<void>;
  proofTerminalStatus(lease: Uint8Array): Promise<PickerProofTerminal>;
  replayProofTerminal(lease: Uint8Array, afterSequence: number): Promise<PickerProofTerminalReplay>;
  closeProofTerminal(lease: Uint8Array): Promise<PickerProofTerminal>;
  writeProofTerminalInput(
    lease: Uint8Array,
    sequence: number,
    data: Uint8Array,
  ): Promise<PickerProofTerminal>;
  resizeProofTerminal(lease: Uint8Array, cols: number, rows: number): Promise<PickerProofTerminal>;
  /** W2 T-term (production): this lease's remote shell and its descendants. */
  inspectTerminal(lease: Uint8Array): Promise<TerminalProcessSnapshot>;
  /** U16 (production): absolute shells from the target's `/etc/shells`. */
  listTerminalShells(): Promise<ReadonlyArray<string>>;
}

function copyLease(lease: Uint8Array) {
  if (lease.length !== PROOF_TOKEN_BYTES) throw new PickerProofOwnerError("invalidOperands");
  return Uint8Array.from(lease);
}

export function makePickerProofTerminalClient(
  execute: (operation: ProofTerminalOperation) => Promise<Outcome>,
  copyEpochAndGeneration: () => Omit<PickerProofTerminalReservation, "lease">,
): PickerProofTerminalClient {
  const terminal = async (operation: ProofTerminalOperation) => {
    const outcome = await execute(operation);
    return outcome.kind === "proofTerminal" ? outcome.value : invalid();
  };
  return {
    async probeProofTerminalCwd(cwd) {
      const outcome = await execute({ kind: "proofTerminalCwd", cwd });
      return outcome.kind === "proofTerminalCwd" ? outcome.value : invalid();
    },
    openProofTerminal: () => terminal({ kind: "openProofTerminal" }),
    async prepareProofTerminal(input) {
      // Admission and request capture happen synchronously when execute starts.
      const binding = copyEpochAndGeneration();
      const outcome = await execute({ ...input, kind: "prepareProofTerminal" });
      if (outcome.kind !== "proofTerminalReservation") return invalid();
      return { ...binding, lease: outcome.value.lease };
    },
    async openReservedProofTerminal(lease) {
      return terminal({ kind: "openProofTerminal", lease: copyLease(lease) });
    },
    async cancelProofTerminalReservation(lease) {
      const outcome = await execute({
        kind: "cancelProofTerminalReservation",
        lease: copyLease(lease),
      });
      if (outcome.kind !== "proofTerminalReservation") return invalid();
    },
    async proofTerminalStatus(lease) {
      return terminal({ kind: "proofTerminalStatus", lease: copyLease(lease) });
    },
    async replayProofTerminal(lease, afterSequence) {
      const outcome = await execute({
        kind: "proofTerminalReplay",
        lease: copyLease(lease),
        afterSequence,
      });
      return outcome.kind === "proofTerminalReplay" ? outcome.value : invalid();
    },
    async closeProofTerminal(lease) {
      return terminal({ kind: "closeProofTerminal", lease: copyLease(lease) });
    },
    async writeProofTerminalInput(lease, sequence, data) {
      if (data.length < 1 || data.length > 4096) throw new PickerProofOwnerError("invalidOperands");
      return terminal({
        kind: "proofTerminalInput",
        lease: copyLease(lease),
        sequence,
        data: Uint8Array.from(data),
      });
    },
    async resizeProofTerminal(lease, cols, rows) {
      return terminal({ kind: "proofTerminalResize", lease: copyLease(lease), cols, rows });
    },
    async inspectTerminal(lease) {
      const requested = copyLease(lease);
      const outcome = await execute({ kind: "terminalInspect", lease: requested });
      if (outcome.kind !== "terminalProcesses") return invalid();
      // The snapshot must answer for this exact lease.
      return Buffer.from(outcome.value.lease).equals(requested) ? outcome.value : invalid();
    },
    async listTerminalShells() {
      const outcome = await execute({ kind: "listTerminalShells" });
      return outcome.kind === "terminalShells" ? outcome.value : invalid();
    },
  };
}
