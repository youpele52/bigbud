import { isLocalExecutionTargetId } from "@bigbud/contracts/core/baseSchemas";
import { MAX_EDIT_BYTES } from "./fileEditDrafts";

/** Editing requires a transport with conditional writes, not merely an SSH host. */
export function canEditFilePreview(input: {
  executionTargetId?: string | undefined;
  sha256: string | null;
  sizeBytes: number | null;
  truncated: boolean;
}): boolean {
  const { executionTargetId, sha256, sizeBytes, truncated } = input;
  const agent =
    executionTargetId?.startsWith("ssh:") &&
    new URLSearchParams(executionTargetId.slice(4)).get("transport") === "agent";
  return (
    (isLocalExecutionTargetId(executionTargetId) || agent === true) &&
    typeof sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(sha256) &&
    sizeBytes !== null &&
    sizeBytes <= MAX_EDIT_BYTES &&
    !truncated
  );
}
