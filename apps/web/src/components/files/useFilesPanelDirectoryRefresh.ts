import { isRemoteExecutionTargetId } from "@bigbud/contracts";
import { useEffect, useMemo, useRef } from "react";

import { readNativeApi } from "../../rpc/nativeApi";
import type { DirectoryState } from "./FilesPanel.shared";
import { createDebouncedDirectoryRefresh } from "./useFilesPanelDirectoryRefresh.logic";

interface UseFilesPanelDirectoryRefreshInput {
  readonly workspaceRoot: string | null;
  readonly workspaceExecutionTargetId?: string | undefined;
  readonly expandedDirectories: Readonly<Record<string, boolean>>;
  readonly directoryStateByPath: Readonly<Record<string, DirectoryState>>;
  readonly loadDirectory: (
    relativePath: string,
    options?: { readonly force?: boolean },
  ) => Promise<void>;
}

export function getVisibleDirectoryPaths(
  expandedDirectories: Readonly<Record<string, boolean>>,
  directoryStateByPath: Readonly<Record<string, DirectoryState>>,
): string[] {
  const visiblePaths = new Set<string>([""]);

  for (const [path, expanded] of Object.entries(expandedDirectories)) {
    if (!expanded || directoryStateByPath[path] === undefined) {
      continue;
    }
    visiblePaths.add(path);
  }

  return [...visiblePaths].toSorted((left, right) => left.localeCompare(right));
}

export function useFilesPanelDirectoryRefresh({
  workspaceRoot,
  workspaceExecutionTargetId,
  expandedDirectories,
  directoryStateByPath,
  loadDirectory,
}: UseFilesPanelDirectoryRefreshInput) {
  const visibleDirectoryPaths = useMemo(
    () => getVisibleDirectoryPaths(expandedDirectories, directoryStateByPath),
    [directoryStateByPath, expandedDirectories],
  );

  const loadDirectoryRef = useRef(loadDirectory);
  loadDirectoryRef.current = loadDirectory;

  const visibleDirectoryPathsRef = useRef(visibleDirectoryPaths);
  visibleDirectoryPathsRef.current = visibleDirectoryPaths;

  const debouncedRefreshRef = useRef(
    createDebouncedDirectoryRefresh(
      (relativePath, options) => loadDirectoryRef.current(relativePath, options),
      () => visibleDirectoryPathsRef.current,
    ),
  );

  useEffect(() => {
    debouncedRefreshRef.current = createDebouncedDirectoryRefresh(
      (relativePath, options) => loadDirectoryRef.current(relativePath, options),
      () => visibleDirectoryPathsRef.current,
    );
  }, []);

  useEffect(() => {
    if (!workspaceRoot) {
      return;
    }

    const api = readNativeApi();
    if (!api || isRemoteExecutionTargetId(workspaceExecutionTargetId)) {
      return;
    }

    const refreshVisibleDirectories = () => {
      debouncedRefreshRef.current.schedule();
    };

    const unsubscribe = visibleDirectoryPaths.map((relativePath) =>
      api.projects.onDirectoryChange(
        {
          cwd: workspaceRoot,
          ...(workspaceExecutionTargetId ? { executionTargetId: workspaceExecutionTargetId } : {}),
          ...(relativePath.length > 0 ? { relativePath } : {}),
        },
        refreshVisibleDirectories,
        {
          onResubscribe: refreshVisibleDirectories,
        },
      ),
    );

    return () => {
      debouncedRefreshRef.current.cancel();
      for (const unsubscribeDirectory of unsubscribe) {
        unsubscribeDirectory();
      }
    };
  }, [visibleDirectoryPaths, workspaceExecutionTargetId, workspaceRoot]);
}
