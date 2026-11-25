import { decodeMessage, type WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import {
  bytesValue,
  invalid,
  PickerProofOwnerError,
  uintValue,
} from "./sshOwnerPickerProof.codec.wire.ts";
import { writeWorkspaceRoot } from "./sshOwnerPickerProof.codec.workspace.ts";

const STATUS_MAX_OUTPUT_BYTES = 1_000_000;
const PROBE_MAX_OUTPUT_BYTES = 4_096;
const outputDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const actionTags = {
  statusPorcelainV2: 1,
  isInsideWorkTree: 2,
  stagedNumstat: 3,
  unstagedNumstat: 4,
  originDefaultRef: 5,
  originRemoteUrl: 6,
  statusPorcelainV2Nul: 7,
  showToplevel: 8,
  restoreTrackedPaths: 9,
  cleanUntrackedPaths: 10,
  stagePaths: 11,
  untrackedNumstat: 12,
} as const;

export type PickerProofWorkspaceGitAction = keyof typeof actionTags;

const MAX_MUTATION_PATHS = 200;
const MAX_RELATIVE_PATH_BYTES = 4_096;

interface WorkspaceGitOperands {
  readonly workspaceRoot: string;
  readonly action: PickerProofWorkspaceGitAction;
  readonly paths?: ReadonlyArray<string>;
}

export interface PickerProofWorkspaceGitInput extends WorkspaceGitOperands {
  readonly executionTargetId: string;
}

export interface ProofWorkspaceGitOperation extends WorkspaceGitOperands {
  readonly kind: "proofWorkspaceGit";
}

export type PickerProofWorkspaceGitOutcome =
  | "unspecified"
  | "exited"
  | "cancelled"
  | "outcomeUnknown";

export interface PickerProofWorkspaceGitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly outcome?: PickerProofWorkspaceGitOutcome;
}

function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || Buffer.byteLength(path) > MAX_RELATIVE_PATH_BYTES) return false;
  if (path.includes("\0") || path.includes("\\") || path.startsWith("/")) return false;
  if (path.startsWith("-")) return false;
  return path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

export function writeWorkspaceGit(writer: WireWriter, operation: ProofWorkspaceGitOperation) {
  const tag = actionTags[operation.action];
  if (typeof tag !== "number") throw new PickerProofOwnerError("invalidOperands");
  const paths = operation.paths ?? [];
  if (paths.length > MAX_MUTATION_PATHS || paths.some((path) => !isSafeRelativePath(path)))
    throw new PickerProofOwnerError("invalidOperands");
  writeWorkspaceRoot(writer, operation);
  writer.fieldUint(2, tag);
  for (const path of paths) writer.fieldString(3, path);
}

function decodeOutput(bytes: Uint8Array): string {
  if (bytes.byteLength > STATUS_MAX_OUTPUT_BYTES) return invalid();
  try {
    return outputDecoder.decode(bytes);
  } catch {
    return invalid();
  }
}

export function readWorkspaceGitResult(bytes: Uint8Array): PickerProofWorkspaceGitResult {
  let code: number | undefined;
  let stdout: string | undefined;
  let stderr: string | undefined;
  let outcome: PickerProofWorkspaceGitOutcome | undefined;
  decodeMessage(bytes, (field, wire, reader) => {
    if (field === 1) {
      if (code !== undefined) return invalid();
      // The accepted int32 range fits in an unsigned varint without narrowing or wrapping.
      code = uintValue(wire, reader);
      if (code > 254) return invalid();
    } else if (field === 2) {
      if (stdout !== undefined) return invalid();
      stdout = decodeOutput(bytesValue(wire, reader));
    } else if (field === 3) {
      if (stderr !== undefined) return invalid();
      stderr = decodeOutput(bytesValue(wire, reader));
    } else if (field === 4) {
      if (outcome !== undefined) return invalid();
      const value = uintValue(wire, reader);
      if (value > 3) return invalid();
      outcome = (["unspecified", "exited", "cancelled", "outcomeUnknown"] as const)[value];
    } else reader.skip(wire);
  });
  // A mutation may report an ambiguous outcome without an ordinary exit code.
  if (code === undefined) {
    if (outcome !== "cancelled" && outcome !== "outcomeUnknown") return invalid();
  }
  return {
    code: code ?? -1,
    stdout: stdout ?? "",
    stderr: stderr ?? "",
    ...(outcome !== undefined ? { outcome } : {}),
  };
}

export function verifyWorkspaceGitResult(
  action: PickerProofWorkspaceGitAction,
  { stdout, stderr }: PickerProofWorkspaceGitResult,
): void {
  // The decoder already enforces the status cap on both wire fields. The probe is smaller.
  if (
    action === "isInsideWorkTree" &&
    (Buffer.byteLength(stdout) > PROBE_MAX_OUTPUT_BYTES ||
      Buffer.byteLength(stderr) > PROBE_MAX_OUTPUT_BYTES)
  ) {
    return invalid();
  }
}
