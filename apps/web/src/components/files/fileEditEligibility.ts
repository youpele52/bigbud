import { isLocalExecutionTargetId } from "@bigbud/contracts/core/baseSchemas";
import { MAX_EDIT_BYTES } from "./fileEditDrafts.state";

interface FileEditPreviewInput {
  executionTargetId?: string | undefined;
  sha256: string | null;
  sizeBytes: number | null;
  truncated: boolean;
}

/** Full reads can reconcile retained drafts even when the disk file exceeds the edit limit. */
export function canReconcileFilePreview(input: FileEditPreviewInput): boolean {
  const { executionTargetId, sha256, sizeBytes, truncated } = input;
  const agent =
    executionTargetId?.startsWith("ssh:") &&
    new URLSearchParams(executionTargetId.slice(4)).get("transport") === "agent";
  return (
    (isLocalExecutionTargetId(executionTargetId) || agent === true) &&
    typeof sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(sha256) &&
    sizeBytes !== null &&
    sizeBytes >= 0 &&
    !truncated
  );
}

/** Editing requires a transport with conditional writes and a bounded, verified text file. */
export function canEditFilePreview(input: FileEditPreviewInput): boolean {
  return (
    canReconcileFilePreview(input) && input.sizeBytes !== null && input.sizeBytes <= MAX_EDIT_BYTES
  );
}
