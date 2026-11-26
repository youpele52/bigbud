import type { PickerProofOperation } from "./sshOwnerPickerProof.codec.ts";
import type { Outcome } from "./sshOwnerPickerProof.codec.outcome.ts";
import { invalid } from "./sshOwnerPickerProof.codec.wire.ts";
import type {
  WorkspaceEntryChange,
  WorkspaceEntryInfo,
} from "./sshOwnerPickerProof.codec.workspaceEntry.ts";

type EntryInput = {
  readonly executionTargetId: string;
  readonly workspaceRoot: string;
  readonly relativePath: string;
};

/** W2 T-files session-FS entry verbs (Request 122–124) on one bound target. */
export interface PickerProofWorkspaceEntryClient {
  workspaceEntryInfo(input: EntryInput): Promise<WorkspaceEntryInfo>;
  renameWorkspaceEntry(
    input: EntryInput & { readonly destinationPath: string; readonly replace?: boolean },
  ): Promise<WorkspaceEntryChange>;
  appendWorkspaceFile(
    input: EntryInput & { readonly contents: Uint8Array },
  ): Promise<WorkspaceEntryChange>;
}

export function makeWorkspaceEntryClient(
  requireTarget: (input: { readonly executionTargetId: string }) => void,
  execute: (operation: PickerProofOperation) => Promise<Exclude<Outcome, { kind: "error" }>>,
): PickerProofWorkspaceEntryClient {
  const change = async (operation: PickerProofOperation) => {
    const outcome = await execute(operation);
    return outcome.kind === "workspaceEntryChange" ? outcome.value : invalid();
  };
  return {
    async workspaceEntryInfo({ executionTargetId, workspaceRoot, relativePath }) {
      requireTarget({ executionTargetId });
      const outcome = await execute({ kind: "workspaceEntryInfo", workspaceRoot, relativePath });
      return outcome.kind === "workspaceEntryInfo" ? outcome.value : invalid();
    },
    renameWorkspaceEntry({
      executionTargetId,
      workspaceRoot,
      relativePath,
      destinationPath,
      replace,
    }) {
      requireTarget({ executionTargetId });
      return change({
        kind: "workspaceRename",
        workspaceRoot,
        relativePath,
        destinationPath,
        ...(replace === true ? { replace } : {}),
      });
    },
    appendWorkspaceFile({ executionTargetId, workspaceRoot, relativePath, contents }) {
      requireTarget({ executionTargetId });
      // Bind the request to one copy even if the caller mutates its buffer.
      return change({
        kind: "workspaceAppend",
        workspaceRoot,
        relativePath,
        contents: Uint8Array.from(contents),
      });
    },
  };
}
