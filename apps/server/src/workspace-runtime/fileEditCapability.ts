import type {
  ProjectFileEditCapability,
  ProjectFileEditReadOnlyReason,
} from "@bigbud/contracts/workspace/project.ts";

import { isLocalExecutionTarget } from "../executionTargets.ts";

/** Largest UTF-8 draft a guarded editor save may send; shared by local and agent backends. */
export const FILE_EDIT_MAX_BYTES = 512 * 1024;

export const guardedFileEdit: ProjectFileEditCapability = {
  mode: "guarded",
  maxBytes: FILE_EDIT_MAX_BYTES,
};

export const readOnlyFileEdit = (
  reason: ProjectFileEditReadOnlyReason,
): ProjectFileEditCapability => ({ mode: "readOnly", maxBytes: 0, reason });

/**
 * Editing support of the in-process (local) workspace backend. Remote targets that reach this
 * backend use legacy SSH, which cannot perform guarded writes; direct SSH editing waits for the
 * Rust SSH owner (remote file editing plan, E2/E3).
 */
export function localBackendFileEdit(
  executionTargetId: string | undefined,
): ProjectFileEditCapability {
  if (isLocalExecutionTarget(executionTargetId)) return guardedFileEdit;
  return readOnlyFileEdit(
    executionTargetId?.startsWith("ssh:") ? "directSshPendingOwner" : "unsupportedTarget",
  );
}
