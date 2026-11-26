import { decodeMessage, type WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import {
  boolValue,
  bytesValue,
  EMPTY,
  invalid,
  PickerProofOwnerError,
  PROOF_TOKEN_BYTES,
  stringValue,
  uintValue,
} from "./sshOwnerPickerProof.codec.wire.ts";

export interface PickerProofTerminal {
  readonly lease: Uint8Array;
  readonly pid: number;
  readonly live: boolean;
  readonly sample: Uint8Array;
  readonly birthGeneration?: Uint8Array;
  readonly nextInputSequence?: number;
}

export interface PickerProofPrepareTerminalInput {
  readonly cwd: string;
  readonly threadId: string;
  readonly terminalId: string;
  readonly cols: number;
  readonly rows: number;
  /** U16 production shell from the target's `/etc/shells`; absent: the login `$SHELL`. */
  readonly shell?: string;
}

export type ProofTerminalOperation =
  | { readonly kind: "proofTerminalCwd"; readonly cwd: string }
  | ({ readonly kind: "prepareProofTerminal" } & PickerProofPrepareTerminalInput)
  | { readonly kind: "openProofTerminal"; readonly lease?: Uint8Array }
  | {
      readonly kind:
        | "proofTerminalStatus"
        | "closeProofTerminal"
        | "cancelProofTerminalReservation";
      readonly lease: Uint8Array;
    }
  | {
      readonly kind: "proofTerminalReplay";
      readonly lease: Uint8Array;
      readonly afterSequence: number;
    }
  | {
      readonly kind: "proofTerminalInput";
      readonly lease: Uint8Array;
      readonly sequence: number;
      readonly data: Uint8Array;
    }
  | {
      readonly kind: "proofTerminalResize";
      readonly lease: Uint8Array;
      readonly cols: number;
      readonly rows: number;
    }
  // W2 T-term production verbs: Request 120 (this lease's shell tree) and 121 (U16).
  | { readonly kind: "terminalInspect"; readonly lease: Uint8Array }
  | { readonly kind: "listTerminalShells" };

const TERMINAL_KINDS: ReadonlySet<string> = new Set<ProofTerminalOperation["kind"]>([
  "proofTerminalCwd",
  "prepareProofTerminal",
  "openProofTerminal",
  "proofTerminalStatus",
  "closeProofTerminal",
  "cancelProofTerminalReservation",
  "proofTerminalReplay",
  "proofTerminalInput",
  "proofTerminalResize",
  "terminalInspect",
  "listTerminalShells",
]);

export function isProofTerminalOperation<O extends { readonly kind: string }>(
  operation: O,
): operation is Extract<O, ProofTerminalOperation> {
  return TERMINAL_KINDS.has(operation.kind);
}

function validateDimensions(cols: number, rows: number) {
  if (
    !Number.isInteger(cols) ||
    cols < 1 ||
    cols > 400 ||
    !Number.isInteger(rows) ||
    rows < 1 ||
    rows > 200
  ) {
    throw new PickerProofOwnerError("invalidOperands");
  }
}

export function writeProofTerminalOperation(
  writer: WireWriter,
  operands: WireWriter,
  operation: ProofTerminalOperation,
) {
  if (operation.kind === "proofTerminalCwd") {
    if (!validCwd(operation.cwd)) throw new PickerProofOwnerError("invalidOperands");
    operands.fieldString(1, operation.cwd);
    writer.fieldRepeatedMessage(34, operands.finish());
    return;
  }
  if (operation.kind === "prepareProofTerminal") {
    validateDimensions(operation.cols, operation.rows);
    operands.fieldString(1, operation.cwd);
    operands.fieldString(2, operation.threadId);
    operands.fieldString(3, operation.terminalId);
    operands.fieldUint(4, operation.cols);
    operands.fieldUint(5, operation.rows);
    if (operation.shell !== undefined) {
      if (!isTerminalShellPath(operation.shell)) throw new PickerProofOwnerError("invalidOperands");
      operands.fieldString(6, operation.shell);
    }
    writer.fieldRepeatedMessage(28, operands.finish());
    return;
  }
  if (operation.kind === "listTerminalShells") {
    writer.fieldRepeatedMessage(121, EMPTY);
    return;
  }
  if (operation.kind === "openProofTerminal" && operation.lease === undefined) {
    writer.fieldRepeatedMessage(15, EMPTY);
    return;
  }
  if (operation.lease?.length !== PROOF_TOKEN_BYTES) {
    throw new PickerProofOwnerError("invalidOperands");
  }
  operands.fieldBytes(1, operation.lease);
  switch (operation.kind) {
    case "openProofTerminal":
      writer.fieldRepeatedMessage(15, operands.finish());
      return;
    case "proofTerminalStatus":
      writer.fieldRepeatedMessage(16, operands.finish());
      return;
    case "closeProofTerminal":
      writer.fieldRepeatedMessage(17, operands.finish());
      return;
    case "cancelProofTerminalReservation":
      writer.fieldRepeatedMessage(32, operands.finish());
      return;
    case "proofTerminalReplay":
      if (!Number.isSafeInteger(operation.afterSequence) || operation.afterSequence < 0)
        throw new PickerProofOwnerError("invalidOperands");
      operands.fieldUint(2, operation.afterSequence);
      writer.fieldRepeatedMessage(33, operands.finish());
      return;
    case "proofTerminalInput":
      if (
        !Number.isSafeInteger(operation.sequence) ||
        operation.sequence < 1 ||
        operation.data.length < 1 ||
        operation.data.length > 4096
      )
        throw new PickerProofOwnerError("invalidOperands");
      operands.fieldUint(2, operation.sequence);
      operands.fieldBytes(3, operation.data);
      writer.fieldRepeatedMessage(26, operands.finish());
      return;
    case "proofTerminalResize":
      validateDimensions(operation.cols, operation.rows);
      operands.fieldUint(2, operation.cols);
      operands.fieldUint(3, operation.rows);
      writer.fieldRepeatedMessage(27, operands.finish());
      return;
    case "terminalInspect":
      writer.fieldRepeatedMessage(120, operands.finish());
  }
}

/** Mirrors the owner's U16 operand rule: absolute, normalized, plain path bytes. */
export function isTerminalShellPath(path: string): boolean {
  return (
    path.length > 1 &&
    path.length <= 256 &&
    /^\/[A-Za-z0-9/._+-]+$/.test(path) &&
    path
      .slice(1)
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function validCwd(cwd: string) {
  return cwd.startsWith("/") && !cwd.includes("\0") && Buffer.byteLength(cwd) <= 4096;
}

export function readProofTerminalCwd(bytes: Uint8Array): string {
  let cwd: string | undefined;
  decodeMessage(bytes, (field, wire, reader) => {
    if (field !== 1 || cwd !== undefined) return invalid();
    cwd = stringValue(wire, reader);
  });
  if (cwd === undefined || !validCwd(cwd)) return invalid();
  return cwd;
}

const MAX_TERMINAL_SAMPLE_BYTES = 64 * 1024;

export function readProofTerminal(bytes: Uint8Array): PickerProofTerminal {
  let lease = EMPTY,
    pid = 0,
    live = false,
    sample = EMPTY;
  let birthGeneration: Uint8Array | undefined;
  let nextInputSequence: number | undefined;
  decodeMessage(bytes, (number, wire, reader) => {
    if (number === 1) {
      if (lease.length !== 0) return invalid();
      lease = bytesValue(wire, reader);
      if (lease.length !== PROOF_TOKEN_BYTES) return invalid();
    } else if (number === 2) {
      pid = uintValue(wire, reader);
      if (pid === 0 || pid > 0xffff_ffff) return invalid();
    } else if (number === 3) live = boolValue(wire, reader);
    else if (number === 4) {
      sample = bytesValue(wire, reader);
      if (sample.length > MAX_TERMINAL_SAMPLE_BYTES) return invalid();
    } else if (number === 5) {
      if (birthGeneration !== undefined) return invalid();
      birthGeneration = bytesValue(wire, reader);
      if (birthGeneration.length !== PROOF_TOKEN_BYTES) return invalid();
    } else if (number === 6) {
      if (nextInputSequence !== undefined) return invalid();
      nextInputSequence = uintValue(wire, reader);
      if (!nextInputSequence) return invalid();
    } else reader.skip(wire);
  });
  if (
    lease.length === 0 ||
    pid === 0 ||
    (nextInputSequence !== undefined && (!birthGeneration || !live))
  )
    return invalid();
  return {
    lease,
    pid,
    live,
    sample,
    ...(birthGeneration ? { birthGeneration } : {}),
    ...(nextInputSequence !== undefined ? { nextInputSequence } : {}),
  };
}

export interface PickerProofTerminalReplay {
  readonly lease: Uint8Array;
  readonly firstRetainedSequence: number;
  readonly nextSequence: number;
  readonly chunks: ReadonlyArray<{ readonly sequence: number; readonly data: Uint8Array }>;
  readonly gap: boolean;
}

export function readProofTerminalReplay(bytes: Uint8Array): PickerProofTerminalReplay {
  let lease: Uint8Array | undefined;
  let firstRetainedSequence: number | undefined;
  let nextSequence: number | undefined;
  let gap: boolean | undefined;
  let total = 0;
  const chunks: Array<{ sequence: number; data: Uint8Array }> = [];
  decodeMessage(bytes, (field, wire, reader) => {
    if (field === 1 && lease === undefined) lease = bytesValue(wire, reader);
    else if (field === 2 && firstRetainedSequence === undefined)
      firstRetainedSequence = uintValue(wire, reader);
    else if (field === 3 && nextSequence === undefined) nextSequence = uintValue(wire, reader);
    else if (field === 5 && gap === undefined) gap = boolValue(wire, reader);
    else if (field === 4 && chunks.length < 8192) {
      let sequence: number | undefined;
      let data: Uint8Array | undefined;
      decodeMessage(bytesValue(wire, reader), (part, type, chunkReader) => {
        if (part === 1 && sequence === undefined) sequence = uintValue(type, chunkReader);
        else if (part === 2 && data === undefined) data = bytesValue(type, chunkReader);
        else invalid();
      });
      if (!sequence || !data?.length) return invalid();
      total += data.length;
      if (total > MAX_TERMINAL_SAMPLE_BYTES) return invalid();
      chunks.push({ sequence, data });
    } else invalid();
  });
  if (
    lease?.length !== PROOF_TOKEN_BYTES ||
    !firstRetainedSequence ||
    !nextSequence ||
    firstRetainedSequence > nextSequence ||
    (gap && chunks.length)
  )
    return invalid();
  return { lease, firstRetainedSequence, nextSequence, chunks, gap: gap ?? false };
}

export function verifyProofTerminalReplay(
  operation: Extract<ProofTerminalOperation, { kind: "proofTerminalReplay" }>,
  replay: PickerProofTerminalReplay,
) {
  const { lease, firstRetainedSequence, nextSequence, gap, chunks } = replay;
  const after = operation.afterSequence;
  if (
    !Buffer.from(lease).equals(operation.lease) ||
    after >= nextSequence ||
    gap !== after < firstRetainedSequence - 1 ||
    (!gap &&
      (chunks.length !== nextSequence - after - 1 ||
        chunks.some((chunk, i) => chunk.sequence !== after + i + 1)))
  )
    return invalid();
}

export interface ProofTerminalReservation {
  readonly lease: Uint8Array;
  readonly cancelled: boolean;
}

export function readProofTerminalReservation(bytes: Uint8Array): ProofTerminalReservation {
  let lease: Uint8Array | undefined;
  let cancelled: boolean | undefined;
  decodeMessage(bytes, (number, wire, reader) => {
    if (number === 1) {
      if (lease !== undefined) return invalid();
      lease = bytesValue(wire, reader);
    } else if (number === 2) {
      if (cancelled !== undefined) return invalid();
      cancelled = boolValue(wire, reader);
    } else reader.skip(wire);
  });
  if (lease?.length !== PROOF_TOKEN_BYTES) return invalid();
  return { lease, cancelled: cancelled ?? false };
}
