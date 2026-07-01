import { openPathFromChat } from "../../../stores/files/filesPanel.open";

export function openChatFileTarget(
  targetPath: string,
  workspaceRoot: string | undefined,
  kind: "file" | "directory" = "file",
): void {
  void openPathFromChat(targetPath, workspaceRoot, kind).catch((error) => {
    console.error("Failed to open file:", error);
  });
}
