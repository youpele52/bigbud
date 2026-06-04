import { isRemoteExecutionTargetId } from "@bigbud/contracts";
import { useEffect, useMemo } from "react";

import { readNativeApi } from "../../rpc/nativeApi";
import type { DirectoryState } from "./FilesPanel.shared";

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
  const visibleDirectoryPathsKey = visibleDirectoryPaths.join("\u0000");

  useEffect(() => {
    if (!workspaceRoot) {
      return;
    }

    const api = readNativeApi();
    if (!api || isRemoteExecutionTargetId(workspaceExecutionTargetId)) {
      return;
    }

    const refreshDirectory = (relativePath: string) => {
      void loadDirectory(relativePath, { force: true });
    };

    const unsubscribe = visibleDirectoryPaths.map((relativePath) =>
      api.projects.onDirectoryChange(
        {
          cwd: workspaceRoot,
          ...(workspaceExecutionTargetId ? { executionTargetId: workspaceExecutionTargetId } : {}),
          ...(relativePath.length > 0 ? { relativePath } : {}),
        },
        () => {
          refreshDirectory(relativePath);
        },
        {
          onResubscribe: () => {
            refreshDirectory(relativePath);
          },
        },
      ),
    );

    return () => {
      for (const unsubscribeDirectory of unsubscribe) {
        unsubscribeDirectory();
      }
    };
  }, [
    loadDirectory,
    visibleDirectoryPaths,
    visibleDirectoryPathsKey,
    workspaceExecutionTargetId,
    workspaceRoot,
  ]);
}
