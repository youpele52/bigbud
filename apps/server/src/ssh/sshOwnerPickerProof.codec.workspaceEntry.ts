import { decodeMessage, WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { validRelativeOperand } from "./sshOwnerPickerProof.codec.workspace.ts";
import { invalid, PickerProofOwnerError, uintValue } from "./sshOwnerPickerProof.codec.wire.ts";

/**
 * W2 T-files session-FS verbs: Request 122 `workspace_entry_info`, 123
 * `workspace_rename`, 124 `workspace_append`; Reply 73 entry info and 74 entry
 * change. Root-relative operands only; no command, argv or environment.
 */
export const MAX_WORKSPACE_APPEND_BYTES = 48 * 1024;

export type WorkspaceEntryOperation =
  | {
      readonly kind: "workspaceEntryInfo";
      readonly workspaceRoot: string;
      /** Empty names the root itself. */
      readonly relativePath: string;
    }
  | {
      readonly kind: "workspaceRename";
      readonly workspaceRoot: string;
      readonly relativePath: string;
      readonly destinationPath: string;
      /** Replace an existing regular-file destination atomically (rename(2)). */
      readonly replace?: boolean;
    }
  | {
      readonly kind: "workspaceAppend";
      readonly workspaceRoot: string;
      readonly relativePath: string;
      readonly contents: Uint8Array;
    };

export interface WorkspaceEntryInfo {
  readonly kind: "missing" | "file" | "directory" | "other";
  readonly size: number;
  readonly mtimeMs: number;
  readonly birthtimeMs: number;
}

export type WorkspaceEntryChange = "done" | "notFound" | "alreadyExists" | "notAFile";

export type WorkspaceEntryOutcome =
  | { kind: "workspaceEntryInfo"; value: WorkspaceEntryInfo }
  | { kind: "workspaceEntryChange"; value: WorkspaceEntryChange };

const ENTRY_KINDS = [undefined, "missing", "file", "directory", "other"] as const;
const CHANGES = [undefined, "done", "notFound", "alreadyExists", "notAFile"] as const;
const KINDS: ReadonlySet<string> = new Set<WorkspaceEntryOperation["kind"]>([
  "workspaceEntryInfo",
  "workspaceRename",
  "workspaceAppend",
]);

export function isWorkspaceEntryOperation<O extends { readonly kind: string }>(
  operation: O,
): operation is Extract<O, WorkspaceEntryOperation> {
  return KINDS.has(operation.kind);
}

const validRoot = (root: string) =>
  root.startsWith("/") && root !== "/" && !root.includes("\0") && Buffer.byteLength(root) <= 4096;

export function writeWorkspaceEntryOperation(
  writer: WireWriter,
  operation: WorkspaceEntryOperation,
) {
  const operands = new WireWriter();
  const relativeOk =
    operation.kind === "workspaceEntryInfo" && operation.relativePath === ""
      ? true
      : validRelativeOperand(operation.relativePath);
  if (!validRoot(operation.workspaceRoot) || !relativeOk)
    throw new PickerProofOwnerError("invalidOperands");
  operands.fieldString(1, operation.workspaceRoot);
  operands.fieldString(2, operation.relativePath);
  switch (operation.kind) {
    case "workspaceEntryInfo":
      writer.fieldRepeatedMessage(122, operands.finish());
      return;
    case "workspaceRename":
      if (
        !validRelativeOperand(operation.destinationPath) ||
        operation.destinationPath === operation.relativePath
      )
        throw new PickerProofOwnerError("invalidOperands");
      operands.fieldString(3, operation.destinationPath);
      if (operation.replace === true) operands.fieldBool(4, true);
      writer.fieldRepeatedMessage(123, operands.finish());
      return;
    case "workspaceAppend":
      if (
        operation.contents.byteLength < 1 ||
        operation.contents.byteLength > MAX_WORKSPACE_APPEND_BYTES
      )
        throw new PickerProofOwnerError("invalidOperands");
      operands.fieldBytes(3, operation.contents);
      writer.fieldRepeatedMessage(124, operands.finish());
  }
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export function readWorkspaceEntryOutcome(
  field: 73 | 74,
  bytes: Uint8Array,
): WorkspaceEntryOutcome {
  const values: (number | undefined)[] = [];
  decodeMessage(bytes, (tag, wire, reader) => {
    if (tag < 1 || tag > (field === 73 ? 4 : 1) || values[tag] !== undefined) return invalid();
    values[tag] = uintValue(wire, reader);
  });
  if (field === 74) {
    const value = CHANGES[values[1] ?? 0];
    return value ? { kind: "workspaceEntryChange", value } : invalid();
  }
  const kind = ENTRY_KINDS[values[1] ?? 0];
  const [size, mtimeMs, birthtimeMs] = [values[2] ?? 0, values[3] ?? 0, values[4] ?? 0];
  if (!kind || size > MAX_SAFE || mtimeMs > MAX_SAFE || birthtimeMs > MAX_SAFE) return invalid();
  return { kind: "workspaceEntryInfo", value: { kind, size, mtimeMs, birthtimeMs } };
}
