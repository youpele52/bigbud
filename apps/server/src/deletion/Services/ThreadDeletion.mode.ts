import type { ThreadRetentionSelectionMode } from "@bigbud/contracts/core/settings.threadRetention.ts";

export type ThreadDeletionMode = "single" | "subtree";

/**
 * The deletion mode a `thread.retention-delete` requests. The decider writes it into
 * `thread.deletion-requested` and the engine's deletion fence must be held in the same mode:
 * the delete handler treats a `subtree` fence on a `single` request as another subtree owner
 * and leaves the request to it, so a mismatch leaves the thread `deleting` forever (D-3).
 */
export function retentionDeletionMode(
  selectionMode: ThreadRetentionSelectionMode | undefined,
): ThreadDeletionMode {
  return selectionMode === "per-thread" ? "single" : "subtree";
}
