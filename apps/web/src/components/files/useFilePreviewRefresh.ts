import { useEffect, useRef } from "react";

import { readNativeApi } from "../../rpc/nativeApi";
import { useServerConfig } from "../../rpc/serverState";
import { getFilePreviewWatchRelativePath } from "./FilePreview.logic";
import { useFilesPanelRefreshContext } from "./FilesPanelRefreshCoordinator";
import { createDebouncedFilePreviewRefresh } from "./useFilePreviewRefresh.logic";
import {
  shouldRetryWorkspaceDirectoryWatch,
  supportsWorkspaceDirectoryWatch,
} from "./workspaceWatchCapability";

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
    const refresh = createDebouncedFilePreviewRefresh(refreshPreview);
    debouncedRefreshRef.current = refresh;
    return refresh.cancel;
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

    let active = true;
    const scheduleRefresh = () => {
      if (active) debouncedRefreshRef.current.schedule();
    };

    const unsubscribe = api.projects.onDirectoryChange(
      buildFilePreviewWatchInput({ cwd, relativePath, executionTargetId }),
      scheduleRefresh,
      {
        onResubscribe: scheduleRefresh,
        shouldRetry: shouldRetryWorkspaceDirectoryWatch,
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [cwd, executionTargetId, refreshContext, relativePath, remoteAgentWatchEnabled]);
}
