import type { ProjectEntry, ThreadId } from "@bigbud/contracts";
import { isBuiltInChatsProject } from "@bigbud/contracts/constants/project.constant";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTheme } from "../../hooks/useTheme";
import { useResolvedWorkspace } from "../../hooks/useResolvedWorkspace";
import { useComposerDraftStore } from "../../stores/composer";
import { useFilesPanelStore } from "../../stores/files/filesPanel.store";
import { canMoveFileHistory, EMPTY_FILE_HISTORY } from "../../stores/files/filesPanel.history";
import { FilesPanelContextMenu, useFilesPanelContextMenu } from "./FilesPanel.contextMenu";
import type { CodeAnnotationDraft } from "./FilePreview";
import { FilesPanelHeader } from "./FilesPanel.header";
import { notifyRemovedFileHistoryEntries } from "./FilesPanel.historyNotification";
import { applyDirectoryNavigationRequest, openFilesPanelEntry } from "./FilesPanel.logic";
import { EMPTY_ENTRIES, makeAnnotationId } from "./FilesPanel.shared";
import { renderFilesPanelTreeBody } from "./FilesPanel.body";
import { FilesPanelRefreshCoordinator } from "./FilesPanelRefreshCoordinator";
import { useFilesTreeWidth } from "./FilesPanel.treeWidth";
import { useFilesPanelDirectoryLoader } from "./useFilesPanelDirectoryLoader";
import {
  useFilesPanelAuxNavigation,
  useFilesPanelHistory,
  useFilesPanelScrollPersistence,
} from "./useFilesPanelHistory";
import { createFilesPanelWorkspaceKey } from "./FilesPanel.workspace";
import { renderFilesPanelPreviewBody } from "./FilesPanel.previewBody";

interface FilesPanelProps {
  activeThreadId?: ThreadId | null;
}

export const FilesPanelContent = memo(function FilesPanelContent({
  activeThreadId,
}: FilesPanelProps) {
  const previewPath = useFilesPanelStore((state) => state.previewPath);
  const previewPosition = useFilesPanelStore((state) => state.previewPosition);
  const fileOpenRequest = useFilesPanelStore((state) => state.fileOpenRequest);
  const workspaceRootOverride = useFilesPanelStore((state) => state.workspaceRootOverride);
  const directoryNavigationRequest = useFilesPanelStore(
    (state) => state.directoryNavigationRequest,
  );
  const histories = useFilesPanelStore((state) => state.histories);
  const setWorkspaceKey = useFilesPanelStore((state) => state.setWorkspaceKey);
  const openPreview = useFilesPanelStore((state) => state.openPreview);
  const consumeFileOpenRequest = useFilesPanelStore((state) => state.consumeFileOpenRequest);
  const consumeDirectoryNavigationRequest = useFilesPanelStore(
    (state) => state.consumeDirectoryNavigationRequest,
  );
  const closePreview = useFilesPanelStore((state) => state.closePreview);
  const removeHistoryPaths = useFilesPanelStore((state) => state.removeHistoryPaths);
  const setPreviewPath = useFilesPanelStore((state) => state.setPreviewPath);
  const setPreviewPosition = useFilesPanelStore((state) => state.setPreviewPosition);
  const {
    project,
    cwd: workspaceRoot,
    executionTargetId: workspaceExecutionTargetId,
  } = useResolvedWorkspace(activeThreadId);
  const { resolvedTheme } = useTheme();
  const addAnnotation = useComposerDraftStore((state) => state.addAnnotation);
  const activeWorkspaceRoot = workspaceRootOverride ?? workspaceRoot;
  const regularProject = project && !isBuiltInChatsProject(project.id) ? project : undefined;
  const activeWorkspaceExecutionTargetId =
    workspaceRootOverride === null ? workspaceExecutionTargetId : undefined;
  const activeProjectName = workspaceRootOverride === null ? regularProject?.name : undefined;
  const workspaceKey = createFilesPanelWorkspaceKey({
    ...(regularProject && workspaceRootOverride === null ? { projectId: regularProject.id } : {}),
    workspaceRoot: activeWorkspaceRoot,
    executionTargetId: activeWorkspaceExecutionTargetId,
    isolatedId: activeThreadId ?? undefined,
  });
  const activeHistory = histories[workspaceKey] ?? EMPTY_FILE_HISTORY;
  const activeHistoryEntry = activeHistory.entries[activeHistory.index];
  const panelContainerRef = useRef<HTMLDivElement>(null);
  const fileTreeContainerRef = useRef<HTMLDivElement>(null);
  const { fileTreeWidth, resizeTreeWidth } = useFilesTreeWidth();
  const previewPathRef = useRef<string | null>(previewPath);
  const previewPositionRef = useRef(previewPosition);
  const [expandedDirectories, setExpandedDirectories] = useState<Record<string, boolean>>({});
  const handleDirectoryEntriesRemoved = useCallback(
    (paths: ReadonlyArray<string>) =>
      notifyRemovedFileHistoryEntries(removeHistoryPaths(workspaceKey, paths)),
    [removeHistoryPaths, workspaceKey],
  );
  const { directoryStateByPath, setDirectoryStateByPath, loadDirectory } =
    useFilesPanelDirectoryLoader({
      workspaceRoot: activeWorkspaceRoot,
      workspaceExecutionTargetId: activeWorkspaceExecutionTargetId,
      previewPathRef,
      previewPositionRef,
      setPreviewPath,
      setPreviewPosition,
      onEntriesRemoved: handleDirectoryEntriesRemoved,
      workspaceKey,
    });
  const { contextMenuState, openContextMenu, closeContextMenu } = useFilesPanelContextMenu();
  const { navigateHistory, removePreviewIfMissing, restoreCurrentPreview } = useFilesPanelHistory({
    workspaceKey,
    workspaceRoot: activeWorkspaceRoot,
    workspaceExecutionTargetId: activeWorkspaceExecutionTargetId,
  });
  const persistScrollPosition = useFilesPanelScrollPersistence(workspaceKey, previewPath);

  const handleNavigateBack = useCallback(() => void navigateHistory(-1), [navigateHistory]);
  const handleNavigateForward = useCallback(() => void navigateHistory(1), [navigateHistory]);
  const handlePreviewLoadError = useCallback(
    (error?: unknown) => {
      if (previewPath) void removePreviewIfMissing(previewPath, error);
    },
    [previewPath, removePreviewIfMissing],
  );

  useEffect(() => {
    previewPathRef.current = previewPath;
  }, [previewPath]);

  useEffect(() => {
    previewPositionRef.current = previewPosition;
  }, [previewPosition]);

  const handleTreeResizeStart = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      const container = fileTreeContainerRef.current;
      if (!container) return;

      const startX = event.clientX;
      const startWidth = fileTreeWidth;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        resizeTreeWidth(
          container.getBoundingClientRect().width,
          startWidth,
          moveEvent.clientX - startX,
        );
      };

      const handleMouseUp = () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [fileTreeWidth, resizeTreeWidth],
  );

  useEffect(() => {
    setWorkspaceKey(workspaceKey);
    setExpandedDirectories({});
    setDirectoryStateByPath({});
    void restoreCurrentPreview();
  }, [
    activeWorkspaceRoot,
    restoreCurrentPreview,
    setDirectoryStateByPath,
    setWorkspaceKey,
    workspaceKey,
  ]);

  useEffect(() => {
    if (!fileOpenRequest) return;

    openPreview({
      path: fileOpenRequest.path,
      position: fileOpenRequest.position,
      scrollTop: null,
    });
    consumeFileOpenRequest(fileOpenRequest.requestId);
  }, [consumeFileOpenRequest, fileOpenRequest, openPreview]);

  const canNavigateHistory = useCallback(
    (direction: -1 | 1) => canMoveFileHistory(activeHistory, direction),
    [activeHistory],
  );
  const navigateFileHistory = useCallback(
    (direction: -1 | 1) => void navigateHistory(direction),
    [navigateHistory],
  );
  useFilesPanelAuxNavigation(panelContainerRef, canNavigateHistory, navigateFileHistory);

  useEffect(() => {
    if (!directoryNavigationRequest) return;

    applyDirectoryNavigationRequest(
      directoryNavigationRequest.path,
      directoryStateByPath,
      loadDirectory,
      setExpandedDirectories,
    );
    consumeDirectoryNavigationRequest(directoryNavigationRequest.requestId);
  }, [
    consumeDirectoryNavigationRequest,
    directoryNavigationRequest,
    directoryStateByPath,
    loadDirectory,
  ]);

  useEffect(() => {
    if (!activeWorkspaceRoot) return;
    if (directoryStateByPath[""] !== undefined) return;
    void loadDirectory("");
  }, [activeWorkspaceRoot, directoryStateByPath, loadDirectory]);

  const rootDirectoryState = directoryStateByPath[""];
  const sortedRootEntries = rootDirectoryState?.entries ?? EMPTY_ENTRIES;
  const showRootLoading = rootDirectoryState?.loading && sortedRootEntries.length === 0;
  const previewTargetLine = previewPosition?.line;

  const handleToggleDirectory = useCallback(
    (entry: ProjectEntry) => {
      setExpandedDirectories((current) => ({
        ...current,
        [entry.path]: !(current[entry.path] ?? false),
      }));
      if (directoryStateByPath[entry.path] === undefined) {
        void loadDirectory(entry.path);
      }
    },
    [directoryStateByPath, loadDirectory],
  );

  const handleOpenFile = useCallback(
    (entry: ProjectEntry) => {
      if (!activeWorkspaceRoot) return;
      openFilesPanelEntry(
        entry,
        activeWorkspaceRoot,
        setPreviewPath,
        setPreviewPosition,
        (path) => openPreview({ path, position: null, scrollTop: null }),
        activeWorkspaceExecutionTargetId,
      );
    },
    [
      activeWorkspaceExecutionTargetId,
      activeWorkspaceRoot,
      openPreview,
      setPreviewPath,
      setPreviewPosition,
    ],
  );

  const handleCreateCodeAnnotation = useCallback(
    (annotation: CodeAnnotationDraft) => {
      if (!activeThreadId || !activeWorkspaceRoot || !previewPath) return;
      addAnnotation(activeThreadId, {
        id: makeAnnotationId(),
        kind: "code",
        comment: annotation.comment,
        intent: annotation.intent,
        createdAt: new Date().toISOString(),
        file: {
          ...(activeProjectName ? { projectName: activeProjectName } : {}),
          cwd: activeWorkspaceRoot,
          relativePath: previewPath,
        },
        selection: {
          startLine: annotation.startLine,
          endLine: annotation.endLine,
          text: annotation.text,
        },
      });
    },
    [activeProjectName, activeThreadId, activeWorkspaceRoot, addAnnotation, previewPath],
  );
  const handleSearchMatch = useCallback(
    (line: number) => setPreviewPosition({ line, column: null }),
    [setPreviewPosition],
  );

  const treeBody = useMemo(() => {
    return renderFilesPanelTreeBody({
      showLoading: showRootLoading,
      error: rootDirectoryState?.error,
      entries: sortedRootEntries,
      workspaceRoot: activeWorkspaceRoot,
      previewPath,
      resolvedTheme,
      expandedDirectories,
      directoryStateByPath,
      onToggleDirectory: handleToggleDirectory,
      onOpenFile: handleOpenFile,
      onOpenContextMenu: openContextMenu,
    });
  }, [
    directoryStateByPath,
    expandedDirectories,
    handleOpenFile,
    handleToggleDirectory,
    openContextMenu,
    previewPath,
    resolvedTheme,
    rootDirectoryState,
    showRootLoading,
    sortedRootEntries,
    activeWorkspaceRoot,
  ]);

  const panelBody = useMemo(() => {
    return renderFilesPanelPreviewBody({
      workspaceRoot: activeWorkspaceRoot,
      previewPath,
      treeBody,
      history: activeHistory,
      historyEntry: activeHistoryEntry,
      targetLine: previewTargetLine,
      executionTargetId: activeWorkspaceExecutionTargetId,
      projectName: activeProjectName,
      fileTreeContainerRef,
      fileTreeWidth,
      onNavigateBack: handleNavigateBack,
      onNavigateForward: handleNavigateForward,
      onClose: closePreview,
      onPreviewLoadError: handlePreviewLoadError,
      onScrollPositionChange: persistScrollPosition,
      onCreateAnnotation: activeThreadId ? handleCreateCodeAnnotation : undefined,
      onSearchMatch: handleSearchMatch,
      onTreeResizeStart: handleTreeResizeStart,
    });
  }, [
    activeThreadId,
    activeHistory,
    activeHistoryEntry,
    closePreview,
    fileTreeWidth,
    handleCreateCodeAnnotation,
    handleNavigateBack,
    handleNavigateForward,
    handleSearchMatch,
    handleTreeResizeStart,
    handlePreviewLoadError,
    previewPath,
    previewTargetLine,
    persistScrollPosition,
    activeProjectName,
    treeBody,
    activeWorkspaceExecutionTargetId,
    activeWorkspaceRoot,
  ]);

  return (
    <div ref={panelContainerRef} className="flex h-full min-h-0 flex-col">
      <FilesPanelHeader />
      <div className="min-h-0 flex-1 overflow-hidden">
        <FilesPanelRefreshCoordinator
          workspaceRoot={activeWorkspaceRoot}
          workspaceExecutionTargetId={activeWorkspaceExecutionTargetId}
          previewPath={previewPath}
          expandedDirectories={expandedDirectories}
          directoryStateByPath={directoryStateByPath}
          loadDirectory={loadDirectory}
        >
          {panelBody}
        </FilesPanelRefreshCoordinator>
      </div>
      <FilesPanelContextMenu
        contextMenuState={contextMenuState}
        workspaceRoot={activeWorkspaceRoot ?? undefined}
        threadId={workspaceRootOverride === null ? activeThreadId : null}
        onClose={closeContextMenu}
      />
    </div>
  );
});
