import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { readNativeApi } from "../../rpc/nativeApi";
import {
  getRemovedEntryPaths,
  reconcilePreviewPathAfterDirectoryRefresh,
} from "./FilesPanel.logic";
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
  readonly onEntriesRemoved: (paths: ReadonlyArray<string>) => void;
  readonly workspaceKey: string;
}

export function shouldQueueForceDirectoryRefresh(
  loading: boolean,
  force: boolean | undefined,
): boolean {
  return loading && force === true;
}

export function isCurrentDirectoryRequest(
  requestGeneration: number,
  currentGeneration: number,
  requestId: number,
  currentRequestId: number | undefined,
): boolean {
  return requestGeneration === currentGeneration && requestId === currentRequestId;
}

export function useFilesPanelDirectoryLoader({
  workspaceRoot,
  workspaceExecutionTargetId,
  previewPathRef,
  previewPositionRef,
  setPreviewPath,
  setPreviewPosition,
  onEntriesRemoved,
  workspaceKey,
}: UseFilesPanelDirectoryLoaderInput) {
  const [directoryStateByPath, setDirectoryStateByPath] = useState<Record<string, DirectoryState>>(
    {},
  );
  const directoryStateRef = useRef(directoryStateByPath);
  const pendingForceRefreshRef = useRef(new Set<string>());
  const workspaceGenerationRef = useRef(0);
  const workspaceIdentityRef = useRef("");
  const directoryRequestIdsRef = useRef(new Map<string, number>());
  const workspaceIdentity = `${workspaceKey}:${workspaceRoot ?? ""}:${workspaceExecutionTargetId ?? ""}`;

  if (workspaceIdentityRef.current !== workspaceIdentity) {
    workspaceIdentityRef.current = workspaceIdentity;
    workspaceGenerationRef.current += 1;
    pendingForceRefreshRef.current.clear();
    directoryRequestIdsRef.current.clear();
  }

  useEffect(() => {
    directoryStateRef.current = directoryStateByPath;
  }, [directoryStateByPath]);

  const loadDirectoryRef = useRef<
    (relativePath: string, options?: { readonly force?: boolean }) => Promise<void>
  >(async () => undefined);

  const runPendingForceRefresh = useCallback((relativePath: string, generation: number) => {
    if (generation !== workspaceGenerationRef.current) return;
    if (!pendingForceRefreshRef.current.delete(relativePath)) {
      return;
    }

    void loadDirectoryRef.current(relativePath, { force: true });
  }, []);

  const loadDirectory = useCallback(
    async (relativePath: string, options?: { readonly force?: boolean }) => {
      if (!workspaceRoot) return;

      const generation = workspaceGenerationRef.current;

      const existing = directoryStateRef.current[relativePath];
      if (shouldQueueForceDirectoryRefresh(existing?.loading === true, options?.force)) {
        pendingForceRefreshRef.current.add(relativePath);
        return;
      }
      if (existing && !options?.force) return;

      const requestId = (directoryRequestIdsRef.current.get(relativePath) ?? 0) + 1;
      directoryRequestIdsRef.current.set(relativePath, requestId);
      const isCurrentRequest = () =>
        isCurrentDirectoryRequest(
          generation,
          workspaceGenerationRef.current,
          requestId,
          directoryRequestIdsRef.current.get(relativePath),
        );

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
        if (!isCurrentRequest()) return;
        const currentPreviewPath = previewPathRef.current;
        const nextPreviewPath = reconcilePreviewPathAfterDirectoryRefresh({
          previewPath: currentPreviewPath,
          refreshedRelativePath: relativePath,
          previousEntries: existing?.entries ?? EMPTY_ENTRIES,
          nextEntries: result.entries,
        });
        const removedPaths = getRemovedEntryPaths(
          existing?.entries ?? EMPTY_ENTRIES,
          result.entries,
        );

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
        if (removedPaths.length > 0) onEntriesRemoved(removedPaths);
      } catch (error) {
        if (!isCurrentRequest()) return;
        setDirectoryStateByPath((current) => ({
          ...current,
          [relativePath]: {
            entries: current[relativePath]?.entries ?? EMPTY_ENTRIES,
            loading: false,
            error: error instanceof Error ? error.message : "Failed to load directory.",
          },
        }));
      } finally {
        runPendingForceRefresh(relativePath, generation);
      }
    },
    [
      previewPathRef,
      previewPositionRef,
      runPendingForceRefresh,
      onEntriesRemoved,
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
