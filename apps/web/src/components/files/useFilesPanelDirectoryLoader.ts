import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";

import { readNativeApi } from "../../rpc/nativeApi";
import { useWorkspaceRequestRecovery } from "../../hooks/useWorkspaceRequestRecovery";
import { workspaceErrorMessage } from "../../lib/workspaceRequestRecovery.errors";
import {
  getRemovedEntryPaths,
  reconcilePreviewPathAfterDirectoryRefresh,
} from "./FilesPanel.logic";
import { EMPTY_ENTRIES, type DirectoryState } from "./FilesPanel.shared";
import { isConfirmedMissingWorkspacePathError } from "./FilesPanel.errors";
import { pruneRemovedPaths } from "./FilesPanel.pathState";

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
  const workspaceIdentity = `${workspaceKey}:${workspaceRoot ?? ""}:${workspaceExecutionTargetId ?? ""}`;
  const recovery = useWorkspaceRequestRecovery(workspaceIdentity, workspaceExecutionTargetId);
  const [directoryStateSnapshot, setDirectoryStateSnapshot] = useState<{
    readonly workspaceIdentity: string;
    readonly values: Record<string, DirectoryState>;
  }>({ workspaceIdentity, values: {} });
  const directoryStateByPath =
    directoryStateSnapshot.workspaceIdentity === workspaceIdentity
      ? directoryStateSnapshot.values
      : {};
  const setDirectoryStateByPath: Dispatch<SetStateAction<Record<string, DirectoryState>>> =
    useCallback(
      (update) => {
        setDirectoryStateSnapshot((current) => {
          const currentValues =
            current.workspaceIdentity === workspaceIdentity ? current.values : {};
          const values = typeof update === "function" ? update(currentValues) : update;
          if (current.workspaceIdentity === workspaceIdentity && values === current.values) {
            return current;
          }
          return { workspaceIdentity, values };
        });
      },
      [workspaceIdentity],
    );
  const directoryStateRef = useRef(directoryStateByPath);
  directoryStateRef.current = directoryStateByPath;
  const pendingForceRefreshRef = useRef(new Set<string>());
  const workspaceGenerationRef = useRef(0);
  const workspaceIdentityRef = useRef("");
  const directoryRequestIdsRef = useRef(new Map<string, number>());

  if (workspaceIdentityRef.current !== workspaceIdentity) {
    workspaceIdentityRef.current = workspaceIdentity;
    workspaceGenerationRef.current += 1;
    pendingForceRefreshRef.current.clear();
    directoryRequestIdsRef.current.clear();
  }

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
      if (shouldQueueForceDirectoryRefresh(recovery.isActive(relativePath), options?.force)) {
        pendingForceRefreshRef.current.add(relativePath);
        return;
      }
      if (recovery.isActive(relativePath) || (existing && !options?.force)) return;

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

      const request = () => {
        const api = readNativeApi();
        if (!api) throw new Error("Native API not found.");
        return api.projects.listDirectory({
          cwd: workspaceRoot,
          ...(workspaceExecutionTargetId ? { executionTargetId: workspaceExecutionTargetId } : {}),
          ...(relativePath.length > 0 ? { relativePath } : {}),
        });
      };
      await recovery
        .execute(relativePath, request, {
          onRecovering: () => {
            if (!isCurrentRequest()) return;
            setDirectoryStateByPath((current) => ({
              ...current,
              [relativePath]: {
                entries: current[relativePath]?.entries ?? EMPTY_ENTRIES,
                loading: true,
                error: null,
                recovering: true,
                requestPending: true,
              },
            }));
          },
          onSuccess: (result) => {
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

            setDirectoryStateByPath((current) => {
              const next = pruneRemovedPaths(current, removedPaths);
              return {
                ...next,
                [relativePath]: {
                  entries: result.entries,
                  loading: false,
                  error: null,
                },
              };
            });
            if (nextPreviewPath !== currentPreviewPath) {
              setPreviewPath(nextPreviewPath);
              if (nextPreviewPath === null && previewPositionRef.current !== null) {
                setPreviewPosition(null);
              }
            }
            if (removedPaths.length > 0) onEntriesRemoved(removedPaths);
          },
          onError: (error, pending) => {
            if (!isCurrentRequest()) return;
            if (relativePath.length > 0 && isConfirmedMissingWorkspacePathError(error)) {
              pendingForceRefreshRef.current.delete(relativePath);
              setDirectoryStateByPath((current) => pruneRemovedPaths(current, [relativePath]));
              onEntriesRemoved([relativePath]);
              return;
            }
            setDirectoryStateByPath((current) => ({
              ...current,
              [relativePath]: {
                entries: current[relativePath]?.entries ?? EMPTY_ENTRIES,
                loading: false,
                error: workspaceErrorMessage(error),
                requestPending: pending,
              },
            }));
          },
          onSettled: () => runPendingForceRefresh(relativePath, generation),
        })
        .catch(() => undefined);
    },
    [
      previewPathRef,
      previewPositionRef,
      recovery,
      runPendingForceRefresh,
      onEntriesRemoved,
      setDirectoryStateByPath,
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
