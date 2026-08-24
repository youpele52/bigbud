import { useEffect, useRef } from "react";

import { readNativeApi } from "../../rpc/nativeApi";
import { useServerConfig } from "../../rpc/serverState";
import { getFilePreviewWatchRelativePath } from "./FilePreview.logic";
import { useFilesPanelRefreshContext } from "./FilesPanelRefreshCoordinator";
import { createDebouncedFilePreviewRefresh } from "./useFilePreviewRefresh.logic";
import { supportsWorkspaceDirectoryWatch } from "./workspaceWatchCapability";

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
  const refreshContext = useFilesPanelRefreshContext();
  const serverConfig = useServerConfig();
  const remoteAgentWatchEnabled = supportsWorkspaceDirectoryWatch(
    executionTargetId,
    serverConfig?.workspaceCapabilities,
  );
  const debouncedRefreshRef = useRef(createDebouncedFilePreviewRefresh(refreshPreview));

  useEffect(() => {
    debouncedRefreshRef.current = createDebouncedFilePreviewRefresh(refreshPreview);
  }, [refreshPreview]);

  useEffect(() => {
    if (!refreshContext) {
      return;
    }
    return refreshContext.registerPreview({ cwd, relativePath, refreshPreview });
  }, [cwd, refreshContext, refreshPreview, relativePath]);

  useEffect(() => {
    const api = readNativeApi();
    if (!api || !remoteAgentWatchEnabled || refreshContext) {
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
  }, [cwd, executionTargetId, refreshContext, relativePath, remoteAgentWatchEnabled]);
}
