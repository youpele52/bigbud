import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { readNativeApi } from "../../rpc/nativeApi";
import { reconcilePreviewPathAfterDirectoryRefresh } from "./FilesPanel.logic";
import { EMPTY_ENTRIES, type DirectoryState } from "./FilesPanel.shared";

interface UseFilesPanelDirectoryLoaderInput {
  readonly workspaceRoot: string | null;
  readonly workspaceExecutionTargetId?: string | undefined;
  readonly previewPathRef: RefObject<string | null>;
  readonly previewPositionRef: RefObject<{ line: number; column: number | null } | null>;
  readonly setPreviewPath: (previewPath: string | null) => void;
  readonly setPreviewPosition: (
    previewPosition: { line: number; column: number | null } | null,
  ) => void;
}

export function shouldQueueForceDirectoryRefresh(
  loading: boolean,
  force: boolean | undefined,
): boolean {
  return loading && force === true;
}

export function useFilesPanelDirectoryLoader({
  workspaceRoot,
  workspaceExecutionTargetId,
  previewPathRef,
  previewPositionRef,
  setPreviewPath,
  setPreviewPosition,
}: UseFilesPanelDirectoryLoaderInput) {
  const [directoryStateByPath, setDirectoryStateByPath] = useState<Record<string, DirectoryState>>(
    {},
  );
  const directoryStateRef = useRef(directoryStateByPath);
  const pendingForceRefreshRef = useRef(new Set<string>());

  useEffect(() => {
    directoryStateRef.current = directoryStateByPath;
  }, [directoryStateByPath]);

  const loadDirectoryRef = useRef<
    (relativePath: string, options?: { readonly force?: boolean }) => Promise<void>
  >(async () => undefined);

  const runPendingForceRefresh = useCallback((relativePath: string) => {
    if (!pendingForceRefreshRef.current.delete(relativePath)) {
      return;
    }

    void loadDirectoryRef.current(relativePath, { force: true });
  }, []);

  const loadDirectory = useCallback(
    async (relativePath: string, options?: { readonly force?: boolean }) => {
      if (!workspaceRoot) return;

      const existing = directoryStateRef.current[relativePath];
      if (shouldQueueForceDirectoryRefresh(existing?.loading === true, options?.force)) {
        pendingForceRefreshRef.current.add(relativePath);
        return;
      }
      if (existing && !options?.force) return;

      setDirectoryStateByPath((current) => ({
        ...current,
        [relativePath]: {
          entries: current[relativePath]?.entries ?? EMPTY_ENTRIES,
          loading: true,
          error: null,
        },
      }));

      try {
        const api = readNativeApi();
        if (!api) {
          throw new Error("Native API not found.");
        }
        const result = await api.projects.listDirectory({
          cwd: workspaceRoot,
          ...(workspaceExecutionTargetId ? { executionTargetId: workspaceExecutionTargetId } : {}),
          ...(relativePath.length > 0 ? { relativePath } : {}),
        });
        const currentPreviewPath = previewPathRef.current;
        const nextPreviewPath = reconcilePreviewPathAfterDirectoryRefresh({
          previewPath: currentPreviewPath,
          refreshedRelativePath: relativePath,
          previousEntries: existing?.entries ?? EMPTY_ENTRIES,
          nextEntries: result.entries,
        });

        setDirectoryStateByPath((current) => ({
          ...current,
          [relativePath]: {
            entries: result.entries,
            loading: false,
            error: null,
          },
        }));
        if (nextPreviewPath !== currentPreviewPath) {
          setPreviewPath(nextPreviewPath);
          if (nextPreviewPath === null && previewPositionRef.current !== null) {
            setPreviewPosition(null);
          }
        }
      } catch (error) {
        setDirectoryStateByPath((current) => ({
          ...current,
          [relativePath]: {
            entries: current[relativePath]?.entries ?? EMPTY_ENTRIES,
            loading: false,
            error: error instanceof Error ? error.message : "Failed to load directory.",
          },
        }));
      } finally {
        runPendingForceRefresh(relativePath);
      }
    },
    [
      previewPathRef,
      previewPositionRef,
      runPendingForceRefresh,
      setPreviewPath,
      setPreviewPosition,
      workspaceExecutionTargetId,
      workspaceRoot,
    ],
  );

  loadDirectoryRef.current = loadDirectory;

  return {
    directoryStateByPath,
    setDirectoryStateByPath,
    loadDirectory,
  };
}
