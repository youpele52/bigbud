import { isRemoteExecutionTargetId } from "@bigbud/contracts";
import { useEffect } from "react";

import { readNativeApi } from "../../rpc/nativeApi";
import { getFilePreviewWatchRelativePath } from "./FilePreview.logic";

interface FilePreviewRefreshInput {
  readonly cwd: string;
  readonly relativePath: string;
  readonly executionTargetId?: string | undefined;
}

interface UseFilePreviewRefreshInput extends FilePreviewRefreshInput {
  readonly refreshPreview: () => void;
}

export function buildFilePreviewWatchInput({
  cwd,
  relativePath,
  executionTargetId,
}: FilePreviewRefreshInput) {
  const watchRelativePath = getFilePreviewWatchRelativePath(relativePath);

  return {
    cwd,
    ...(executionTargetId ? { executionTargetId } : {}),
    ...(watchRelativePath ? { relativePath: watchRelativePath } : {}),
  };
}

export function useFilePreviewRefresh({
  cwd,
  relativePath,
  executionTargetId,
  refreshPreview,
}: UseFilePreviewRefreshInput) {
  useEffect(() => {
    const api = readNativeApi();
    if (!api || isRemoteExecutionTargetId(executionTargetId)) {
      return;
    }

    return api.projects.onDirectoryChange(
      buildFilePreviewWatchInput({ cwd, relativePath, executionTargetId }),
      () => {
        refreshPreview();
      },
      {
        onResubscribe: refreshPreview,
      },
    );
  }, [cwd, executionTargetId, refreshPreview, relativePath]);
}
