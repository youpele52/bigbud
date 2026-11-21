import {
  LOCAL_EXECUTION_TARGET_ID,
  type ExecutionTargetId,
} from "@bigbud/contracts/core/baseSchemas";

import { openPathFromChat } from "../../../stores/files/filesPanel.open";

export function openChatFileTarget(
  targetPath: string,
  workspaceRoot: string | undefined,
  kind: "file" | "directory" = "file",
  /** The target `workspaceRoot` is on (`useFileOpenTarget()`); omitted means local. */
  executionTargetId?: ExecutionTargetId | undefined,
): void {
  void openPathFromChat(targetPath, workspaceRoot, kind, executionTargetId).catch((error) => {
    console.error("Failed to open file:", error);
  });
}

/**
 * Opens a discovered skill or agent file. Discovery reads this computer only, so its absolute
 * `sourcePath` is local whatever thread or project is open.
 */
export function openDiscoveredSourcePath(sourcePath: string): void {
  openChatFileTarget(sourcePath, undefined, "file", LOCAL_EXECUTION_TARGET_ID);
}
