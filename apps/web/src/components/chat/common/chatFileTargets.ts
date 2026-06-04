import { openPathFromChat } from "../../../stores/files/filesPanel.open";

export function openChatFileTarget(targetPath: string, workspaceRoot: string | undefined): void {
  void openPathFromChat(targetPath, workspaceRoot).catch((error) => {
    console.error("Failed to open file:", error);
  });
}
