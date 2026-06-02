import { readNativeApi } from "../../../rpc/nativeApi";
import { canOpenPathInFilesPanel, openPathFromChat } from "../../../stores/files/filesPanel.open";
import { openPathInPreferredApp } from "../../../models/editor";

type ContextMenuPosition = {
  x: number;
  y: number;
};

export function openChatFileTarget(targetPath: string, workspaceRoot: string | undefined): void {
  void openPathFromChat(targetPath, workspaceRoot).catch((error) => {
    console.error("Failed to open file:", error);
  });
}

export function showChatFileTargetContextMenu(
  targetPath: string,
  workspaceRoot: string | undefined,
  position: ContextMenuPosition,
): void {
  const api = readNativeApi();
  if (!api?.contextMenu) {
    return;
  }

  const supportsInAppViewer = canOpenPathInFilesPanel(targetPath, workspaceRoot);
  const menuItems = supportsInAppViewer
    ? [
        { id: "open-in-viewer", label: "Open in file viewer" },
        { id: "open-externally", label: "Open externally" },
      ]
    : [{ id: "open-externally", label: "Open externally" }];

  void api.contextMenu.show(menuItems, position).then((action) => {
    if (action === "open-in-viewer") {
      openChatFileTarget(targetPath, workspaceRoot);
      return;
    }

    if (action === "open-externally") {
      const nativeApi = readNativeApi();
      if (!nativeApi) {
        return;
      }
      void openPathInPreferredApp(nativeApi, targetPath).catch((error) => {
        console.error("Failed to open file externally:", error);
      });
    }
  });
}
