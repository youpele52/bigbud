import { posix } from "node:path";

import { decodeMessage, type WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { boolValue, bytesValue, invalid, uintValue } from "./sshOwnerPickerProof.codec.wire.ts";

const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_IDENTITY_BYTES = 256;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_TIMEOUT_MS = 120_000;

export interface ProofShellResult {
  readonly output: string;
  readonly exitCode: number;
  readonly truncated: boolean;
  readonly timedOut: boolean;
}

export interface ProofAcpCommandResult {
  readonly output: string;
  readonly exitCode: number;
  readonly truncated: boolean;
}

export type ProofShellOperation =
  | {
      readonly kind: "proofRunThreadShell";
      readonly workspaceRoot: string;
      readonly cwd: string;
      readonly threadId: string;
      readonly command: string;
      readonly timeoutMs: number;
    }
  | {
      readonly kind: "proofRunProviderWorkspaceShell";
      readonly workspaceRoot: string;
      readonly cwd: string;
      readonly provider: string;
      readonly sessionId: string;
      readonly invocationId: string;
      readonly command: string;
      readonly timeoutMs: number;
    }
  | {
      readonly kind: "proofRunAcpCommand";
      readonly workspaceRoot: string;
      readonly cwd: string;
    };

export const SHELL_PROVIDERS = [
  "claude",
  "codex",
  "copilot",
  "cursor",
  "devin",
  "opencode",
  "pi",
  "thread-tool",
] as const;

function validPath(value: string): boolean {
  return (
    posix.isAbsolute(value) &&
    !value.includes("\0") &&
    (value === "/" || !value.endsWith("/")) &&
    posix.normalize(value) === value
  );
}

export function validIdentity(value: string): boolean {
  return value.length > 0 && value.length <= MAX_IDENTITY_BYTES && !value.includes("\0");
}

export function validCommand(value: string): boolean {
  return value.length > 0 && !value.includes("\0") && Buffer.byteLength(value) <= MAX_COMMAND_BYTES;
}

export function validTimeout(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= MAX_TIMEOUT_MS;
}

export function writeProofShellOperation(
  writer: WireWriter,
  operands: WireWriter,
  operation: ProofShellOperation,
) {
  if (!validPath(operation.workspaceRoot) || !validPath(operation.cwd)) throw invalid();
  operands.fieldString(1, operation.workspaceRoot);
  operands.fieldString(2, operation.cwd);
  if (operation.kind === "proofRunThreadShell") {
    if (!validIdentity(operation.threadId) || !validCommand(operation.command)) throw invalid();
    if (!validTimeout(operation.timeoutMs)) throw invalid();
    operands.fieldString(3, operation.threadId);
    operands.fieldString(4, operation.command);
    operands.fieldUint(5, operation.timeoutMs);
    writer.fieldRepeatedMessage(67, operands.finish());
    return;
  }
  if (operation.kind === "proofRunProviderWorkspaceShell") {
    if (
      !SHELL_PROVIDERS.includes(operation.provider as (typeof SHELL_PROVIDERS)[number]) ||
      !validIdentity(operation.sessionId) ||
      !validIdentity(operation.invocationId) ||
      !validCommand(operation.command) ||
      !validTimeout(operation.timeoutMs)
    )
      throw invalid();
    operands.fieldString(3, operation.provider);
    operands.fieldString(4, operation.sessionId);
    operands.fieldString(5, operation.invocationId);
    operands.fieldString(6, operation.command);
    operands.fieldUint(7, operation.timeoutMs);
    writer.fieldRepeatedMessage(68, operands.finish());
    return;
  }
  writer.fieldRepeatedMessage(69, operands.finish());
}

const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

function readOutput(bytes: Uint8Array): string {
  if (bytes.length > MAX_OUTPUT_BYTES) return invalid();
  return decoder.decode(bytes);
}

export function readProofShellResult(bytes: Uint8Array): ProofShellResult {
  let output = "";
  let exitCode: number | undefined;
  let truncated: boolean | undefined;
  let timedOut: boolean | undefined;
  decodeMessage(bytes, (field, wire, reader) => {
    if (field === 1) output = readOutput(bytesValue(wire, reader));
    else if (field === 2) exitCode = uintValue(wire, reader);
    else if (field === 3) truncated = boolValue(wire, reader);
    else if (field === 4) timedOut = boolValue(wire, reader);
    else reader.skip(wire);
  });
  if (exitCode !== undefined && exitCode > 255) return invalid();
  return {
    output,
    exitCode: exitCode ?? 0,
    truncated: truncated ?? false,
    timedOut: timedOut ?? false,
  };
}

export function readProofAcpCommandResult(bytes: Uint8Array): ProofAcpCommandResult {
  let output = "";
  let exitCode: number | undefined;
  let truncated: boolean | undefined;
  decodeMessage(bytes, (field, wire, reader) => {
    if (field === 1) output = readOutput(bytesValue(wire, reader));
    else if (field === 2) exitCode = uintValue(wire, reader);
    else if (field === 3) truncated = boolValue(wire, reader);
    else reader.skip(wire);
  });
  if (exitCode !== undefined && exitCode > 255) return invalid();
  return { output, exitCode: exitCode ?? 0, truncated: truncated ?? false };
}
