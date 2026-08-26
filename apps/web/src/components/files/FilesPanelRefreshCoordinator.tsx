import type { ProjectDirectoryWatchEvent } from "@bigbud/contracts/workspace/project";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

import { readNativeApi } from "../../rpc/nativeApi";
import { useServerConfig } from "../../rpc/serverState";
import type { DirectoryState } from "./FilesPanel.shared";
import { getFilePreviewWatchRelativePath } from "./FilePreview.logic";
import { getParentDirectoryPath } from "./FilesPanel.logic";
import { getDirectoryPathReachability, getVisibleDirectoryPaths } from "./FilesPanel.pathState";
import {
  createFilesPanelRefreshCoordinator,
  getPrioritizedWatchedDirectoryPaths,
  getWatchedDirectoryPathSetKey,
  getWorkspaceDirectoryWatchErrorAction,
  shouldRefreshPreviewForDirectoryEvent,
  type FilesPanelRefreshTask,
} from "./FilesPanelRefreshCoordinator.logic";
import {
  shouldRetryWorkspaceDirectoryWatch,
  supportsWorkspaceDirectoryWatch,
} from "./workspaceWatchCapability";
import { toastManager } from "../ui/toast";

interface PreviewRegistration {
  readonly cwd: string;
  readonly relativePath: string;
  readonly refreshPreview: () => void | Promise<void>;
}

interface FilesPanelRefreshContextValue {
  readonly registerPreview: (registration: PreviewRegistration) => () => void;
}

interface FilesPanelRefreshCoordinatorProps {
  readonly workspaceRoot: string | null;
  readonly workspaceExecutionTargetId?: string | undefined;
  readonly previewPath: string | null;
  readonly expandedDirectories: Readonly<Record<string, boolean>>;
  readonly directoryStateByPath: Readonly<Record<string, DirectoryState>>;
  readonly loadDirectory: (
    relativePath: string,
    options?: { readonly force?: boolean },
  ) => Promise<void>;
  readonly children: ReactNode;
}

const FilesPanelRefreshContext = createContext<FilesPanelRefreshContextValue | null>(null);

function directoryTask(
  relativePath: string,
  priority: number,
  loadDirectory: FilesPanelRefreshCoordinatorProps["loadDirectory"],
): FilesPanelRefreshTask {
  return {
    key: `directory:${relativePath}`,
    priority,
    run: () => loadDirectory(relativePath, { force: true }),
  };
}

export function useFilesPanelRefreshContext(): FilesPanelRefreshContextValue | null {
  return useContext(FilesPanelRefreshContext);
}

export function FilesPanelRefreshCoordinator({
  workspaceRoot,
  workspaceExecutionTargetId,
  previewPath,
  expandedDirectories,
  directoryStateByPath,
  loadDirectory,
  children,
}: FilesPanelRefreshCoordinatorProps) {
  const serverConfig = useServerConfig();
  const watchEnabled = supportsWorkspaceDirectoryWatch(
    workspaceExecutionTargetId,
    serverConfig?.workspaceCapabilities,
  );
  const previewRegistrationRef = useRef<PreviewRegistration | null>(null);
  const loadDirectoryRef = useRef(loadDirectory);
  loadDirectoryRef.current = loadDirectory;
  const coordinator = useMemo(() => createFilesPanelRefreshCoordinator(), []);

  const registerPreview = useCallback((registration: PreviewRegistration) => {
    previewRegistrationRef.current = registration;
    return () => {
      if (previewRegistrationRef.current === registration) {
        previewRegistrationRef.current = null;
      }
    };
  }, []);

  const contextValue = useMemo(() => ({ registerPreview }), [registerPreview]);
  const visibleDirectoryPaths = useMemo(
    () => getVisibleDirectoryPaths(expandedDirectories, directoryStateByPath),
    [directoryStateByPath, expandedDirectories],
  );
  const activePreviewDirectory = previewPath
    ? (getFilePreviewWatchRelativePath(previewPath) ?? "")
    : null;
  const reachablePreviewDirectory =
    activePreviewDirectory !== null &&
    getDirectoryPathReachability(activePreviewDirectory, directoryStateByPath) === "reachable"
      ? activePreviewDirectory
      : null;
  const nextWatchedDirectoryPaths = useMemo(() => {
    const paths = new Set(visibleDirectoryPaths);
    if (reachablePreviewDirectory !== null) paths.add(reachablePreviewDirectory);
    return getPrioritizedWatchedDirectoryPaths([...paths], reachablePreviewDirectory);
  }, [reachablePreviewDirectory, visibleDirectoryPaths]);
  const watchedDirectoryPathSetKey = getWatchedDirectoryPathSetKey(nextWatchedDirectoryPaths);
  const stableWatchedDirectoryPathsRef = useRef({
    key: watchedDirectoryPathSetKey,
    paths: nextWatchedDirectoryPaths,
  });
  if (stableWatchedDirectoryPathsRef.current.key !== watchedDirectoryPathSetKey) {
    stableWatchedDirectoryPathsRef.current = {
      key: watchedDirectoryPathSetKey,
      paths: nextWatchedDirectoryPaths,
    };
  }
  const watchedDirectoryPaths = stableWatchedDirectoryPathsRef.current.paths;
  const workspaceIdentity = `${workspaceRoot ?? ""}\u0000${workspaceExecutionTargetId ?? ""}`;
  const watchErrorStateRef = useRef({ workspaceIdentity, shown: false });
  if (watchErrorStateRef.current.workspaceIdentity !== workspaceIdentity) {
    watchErrorStateRef.current = { workspaceIdentity, shown: false };
  }

  useEffect(() => {
    return () => coordinator.dispose();
  }, [coordinator]);

  useEffect(() => {
    coordinator.cancelAll();
    if (!workspaceRoot || !watchEnabled) return;

    const api = readNativeApi();
    if (!api) return;

    const previewTask = (): FilesPanelRefreshTask | null => {
      if (!previewPath) return null;
      return {
        key: `preview:${workspaceRoot}:${previewPath}`,
        priority: 0,
        run: () => {
          const registration = previewRegistrationRef.current;
          if (registration?.cwd === workspaceRoot && registration.relativePath === previewPath) {
            return registration.refreshPreview();
          }
        },
      };
    };
    const tasksForFullSweep = (): FilesPanelRefreshTask[] => {
      const tasks: FilesPanelRefreshTask[] = [];
      const currentPreviewTask = previewTask();
      if (currentPreviewTask) tasks.push(currentPreviewTask);
      if (reachablePreviewDirectory !== null) {
        tasks.push(directoryTask(reachablePreviewDirectory, 10, loadDirectoryRef.current));
      }
      for (const relativePath of watchedDirectoryPaths) {
        if (relativePath === reachablePreviewDirectory) continue;
        tasks.push(
          directoryTask(
            relativePath,
            relativePath.length === 0 ? 20 : 30,
            loadDirectoryRef.current,
          ),
        );
      }
      return tasks;
    };
    const scheduleDirectoryEvent = (event: ProjectDirectoryWatchEvent) => {
      if (event.type === "rescanRequired") {
        coordinator.scheduleAll(tasksForFullSweep());
        return;
      }

      const relativePath = event.relativePath;
      const tasks: FilesPanelRefreshTask[] = [];
      const currentPreviewTask = previewTask();
      const previewChanged = shouldRefreshPreviewForDirectoryEvent(
        event,
        previewPath,
        activePreviewDirectory,
      );
      if (currentPreviewTask && previewChanged) {
        tasks.push(currentPreviewTask);
      }
      if (watchedDirectoryPaths.includes(relativePath)) {
        tasks.push(
          directoryTask(
            relativePath,
            relativePath === reachablePreviewDirectory ? 10 : relativePath.length === 0 ? 20 : 30,
            loadDirectoryRef.current,
          ),
        );
      }
      coordinator.scheduleAll(tasks);
    };
    const unsubscribe = watchedDirectoryPaths.map((relativePath) =>
      api.projects.onDirectoryChange(
        {
          cwd: workspaceRoot,
          ...(workspaceExecutionTargetId ? { executionTargetId: workspaceExecutionTargetId } : {}),
          ...(relativePath.length > 0 ? { relativePath } : {}),
        },
        scheduleDirectoryEvent,
        {
          onError: (error) => {
            if (watchErrorStateRef.current.workspaceIdentity !== workspaceIdentity) return;
            if (getWorkspaceDirectoryWatchErrorAction(relativePath, error) === "reconcileChild") {
              const parentPath = getParentDirectoryPath(relativePath);
              coordinator.schedule(
                directoryTask(
                  parentPath,
                  parentPath.length === 0 ? 20 : 10,
                  loadDirectoryRef.current,
                ),
              );
              return;
            }
            if (watchErrorStateRef.current.shown) return;
            watchErrorStateRef.current.shown = true;
            toastManager.add({
              type: "error",
              title: "Automatic file refresh unavailable",
              description:
                error instanceof Error
                  ? error.message
                  : "The workspace watcher could not be started.",
            });
          },
          onResubscribe: () => coordinator.scheduleAll(tasksForFullSweep()),
          shouldRetry: shouldRetryWorkspaceDirectoryWatch,
        },
      ),
    );

    return () => {
      for (const unsubscribeDirectory of unsubscribe) unsubscribeDirectory();
      coordinator.cancelAll();
    };
  }, [
    activePreviewDirectory,
    coordinator,
    previewPath,
    reachablePreviewDirectory,
    watchEnabled,
    watchedDirectoryPaths,
    watchedDirectoryPathSetKey,
    workspaceExecutionTargetId,
    workspaceIdentity,
    workspaceRoot,
  ]);

  return (
    <FilesPanelRefreshContext.Provider value={contextValue}>
      {children}
    </FilesPanelRefreshContext.Provider>
  );
}
