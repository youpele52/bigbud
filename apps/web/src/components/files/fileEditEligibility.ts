import { isLocalExecutionTargetId } from "@bigbud/contracts/core/baseSchemas";
import type {
  ProjectFileEditCapability,
  ProjectFileEditReadOnlyReason,
} from "@bigbud/contracts/workspace/project";
import { MAX_EDIT_BYTES } from "./fileEditDrafts.state";

interface FileEditPreviewInput {
  executionTargetId?: string | undefined;
  sha256: string | null;
  sizeBytes: number | null;
  truncated: boolean;
  /** Server-reported support; when absent (older server) the target ID is used instead. */
  edit?: ProjectFileEditCapability | null | undefined;
}

/** Pre-capability servers: local targets and remote-agent SSH targets support guarded writes. */
function targetSupportsGuardedWrites(executionTargetId: string | undefined): boolean {
  const agent =
    executionTargetId?.startsWith("ssh:") &&
    new URLSearchParams(executionTargetId.slice(4)).get("transport") === "agent";
  return isLocalExecutionTargetId(executionTargetId) || agent === true;
}

/** Full reads can reconcile retained drafts even when the disk file exceeds the edit limit. */
export function canReconcileFilePreview(input: FileEditPreviewInput): boolean {
  const { executionTargetId, sha256, sizeBytes, truncated, edit } = input;
  const supported = edit ? edit.mode === "guarded" : targetSupportsGuardedWrites(executionTargetId);
  return (
    supported &&
    typeof sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(sha256) &&
    sizeBytes !== null &&
    sizeBytes >= 0 &&
    !truncated
  );
}

/** Editing requires a transport with conditional writes and a bounded, verified text file. */
export function canEditFilePreview(input: FileEditPreviewInput): boolean {
  const limit = input.edit ? Math.min(input.edit.maxBytes, MAX_EDIT_BYTES) : MAX_EDIT_BYTES;
  return canReconcileFilePreview(input) && input.sizeBytes !== null && input.sizeBytes <= limit;
}

/** Why a file is read only, when the server said so or the transport is known to lack saves. */
export function fileEditReadOnlyReason(input: {
  executionTargetId?: string | undefined;
  edit?: ProjectFileEditCapability | null | undefined;
}): ProjectFileEditReadOnlyReason | null {
  if (input.edit)
    return input.edit.mode === "readOnly" ? (input.edit.reason ?? "unsupportedTarget") : null;
  return input.executionTargetId?.includes("transport=direct-ssh") ? "directSshPendingOwner" : null;
}

export const FILE_EDIT_READ_ONLY_COPY: Record<ProjectFileEditReadOnlyReason, string> = {
  directSshPendingOwner:
    "Direct SSH files can't be edited yet. Switch this project to the remote agent transport to edit.",
  agentTooOld: "This host's remote agent is too old to save files. Update the agent to edit.",
  ownerUnavailable: "Editing is unavailable because the remote connection owner isn't running.",
  unsupportedTarget: "Editing isn't supported for this location.",
};
