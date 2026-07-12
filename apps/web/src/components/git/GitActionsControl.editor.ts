import { type ThreadId } from "@bigbud/contracts";
import { useCallback } from "react";

import { openInPreferredEditor } from "../../models/editor";
import { readNativeApi } from "../../rpc/nativeApi";
import { resolvePathLinkTarget } from "../../utils/terminal";
import { toastManager } from "~/components/ui/toast";

export function useChangedFileEditor({
  gitCwd,
  threadToastData,
}: {
  gitCwd: string | null;
  threadToastData: { threadId: ThreadId } | undefined;
}) {
  return useCallback(
    (filePath: string) => {
      const api = readNativeApi();
      if (!api || !gitCwd) {
        toastManager.add({
          type: "error",
          title: "Editor opening is unavailable.",
          data: threadToastData,
        });
        return;
      }
      const target = resolvePathLinkTarget(filePath, gitCwd);
      void openInPreferredEditor(api, target).catch((error) => {
        toastManager.add({
          type: "error",
          title: "Unable to open file",
          description: error instanceof Error ? error.message : "An error occurred.",
          data: threadToastData,
        });
      });
    },
    [gitCwd, threadToastData],
  );
}
