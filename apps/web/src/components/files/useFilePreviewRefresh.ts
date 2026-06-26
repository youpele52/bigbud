import { isRemoteExecutionTargetId } from "@bigbud/contracts";
import { useEffect, useRef } from "react";

import { readNativeApi } from "../../rpc/nativeApi";
import { getFilePreviewWatchRelativePath } from "./FilePreview.logic";
import { createDebouncedFilePreviewRefresh } from "./useFilePreviewRefresh.logic";

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
  const debouncedRefreshRef = useRef(createDebouncedFilePreviewRefresh(refreshPreview));

  useEffect(() => {
    debouncedRefreshRef.current = createDebouncedFilePreviewRefresh(refreshPreview);
  }, [refreshPreview]);

  useEffect(() => {
    const api = readNativeApi();
    if (!api || isRemoteExecutionTargetId(executionTargetId)) {
      return;
    }

    const scheduleRefresh = () => {
      debouncedRefreshRef.current.schedule();
    };

    return api.projects.onDirectoryChange(
      buildFilePreviewWatchInput({ cwd, relativePath, executionTargetId }),
      scheduleRefresh,
      {
        onResubscribe: scheduleRefresh,
      },
    );
  }, [cwd, executionTargetId, relativePath]);
}
