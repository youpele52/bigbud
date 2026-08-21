import { isRemoteExecutionTargetId, type ProjectEntry, type ThreadId } from "@bigbud/contracts";
import { isBuiltInChatsProject } from "@bigbud/contracts/constants/project.constant";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTheme } from "../../hooks/useTheme";
import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import { useDefaultChatCwd } from "../../rpc/serverState";
import { useComposerDraftStore } from "../../stores/composer";
import { useFilesPanelStore } from "../../stores/files/filesPanel.store";
import { canMoveFileHistory, EMPTY_FILE_HISTORY } from "../../stores/files/filesPanel.history";
import { useProjectById, useThreadById } from "../../stores/main";
import { useUiStateStore } from "../../stores/ui";
import { FilesPanelContextMenu, useFilesPanelContextMenu } from "./FilesPanel.contextMenu";
import type { CodeAnnotationDraft } from "./FilePreview";
import { FilesPanelHeader } from "./FilesPanel.header";
import { notifyRemovedFileHistoryEntries } from "./FilesPanel.historyNotification";
import { applyDirectoryNavigationRequest, openFilesPanelEntry } from "./FilesPanel.logic";
import { EMPTY_ENTRIES, FILE_PREVIEW_MIN_WIDTH, makeAnnotationId } from "./FilesPanel.shared";
import { renderFilesPanelTree } from "./FilesPanel.tree";
import { useFilesTreeWidth } from "./FilesPanel.treeWidth";
import { useFilesPanelDirectoryLoader } from "./useFilesPanelDirectoryLoader";
import { useFilesPanelDirectoryRefresh } from "./useFilesPanelDirectoryRefresh";
import {
  useFilesPanelAuxNavigation,
  useFilesPanelHistory,
  useFilesPanelScrollPersistence,
} from "./useFilesPanelHistory";
import { createFilesPanelWorkspaceKey } from "./FilesPanel.workspace";
import { FilesPanelPreview } from "./FilesPanel.preview";

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
  const thread = useThreadById(activeThreadId ?? null);
  const selectedProjectId = useUiStateStore((state) => state.selectedProjectId);
  const project = useProjectById(thread?.projectId ?? selectedProjectId ?? null);
  const { resolvedTheme } = useTheme();
  const defaultChatCwd = useDefaultChatCwd();
  const addAnnotation = useComposerDraftStore((state) => state.addAnnotation);
  const workspaceRoot = thread?.worktreePath ?? project?.cwd ?? defaultChatCwd ?? null;
  const activeWorkspaceRoot = workspaceRootOverride ?? workspaceRoot;
  const regularProject = project && !isBuiltInChatsProject(project.id) ? project : undefined;
  const workspaceExecutionTargetId = thread
    ? resolveWorkspaceExecutionTargetId(thread)
    : project
      ? resolveWorkspaceExecutionTargetId(project)
      : undefined;
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

  useFilesPanelDirectoryRefresh({
    workspaceRoot: activeWorkspaceRoot,
    workspaceExecutionTargetId: activeWorkspaceExecutionTargetId,
    expandedDirectories,
    directoryStateByPath,
    loadDirectory,
  });

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
  const remoteWorkspace = isRemoteExecutionTargetId(activeWorkspaceExecutionTargetId);
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
      openFilesPanelEntry(entry, activeWorkspaceRoot, setPreviewPath, setPreviewPosition, (path) =>
        openPreview({ path, position: null, scrollTop: null }),
      );
    },
    [activeWorkspaceRoot, openPreview, setPreviewPath, setPreviewPosition],
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
    if (showRootLoading) {
      return <div className="p-3 text-sm text-muted-foreground/70">Loading files...</div>;
    }
    if (rootDirectoryState?.error) {
      return <div className="p-3 text-sm text-destructive/80">{rootDirectoryState.error}</div>;
    }
    return (
      <div className="space-y-0.5 p-2">
        {renderFilesPanelTree({
          entries: sortedRootEntries,
          depth: 0,
          workspaceRoot: activeWorkspaceRoot,
          previewPath,
          resolvedTheme,
          expandedDirectories,
          directoryStateByPath,
          onToggleDirectory: handleToggleDirectory,
          onOpenFile: handleOpenFile,
          onOpenContextMenu: openContextMenu,
        })}
      </div>
    );
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
    if (!activeWorkspaceRoot) {
      return (
        <div className="p-3 text-sm text-muted-foreground/70">
          Select a project to browse files.
        </div>
      );
    }
    if (remoteWorkspace) {
      return (
        <div className="p-3 text-sm text-muted-foreground/70">
          Remote workspaces are not supported in the Files panel yet.
        </div>
      );
    }
    if (!previewPath) {
      return <div className="h-full overflow-y-auto">{treeBody}</div>;
    }
    const canNavigateBack = canMoveFileHistory(activeHistory, -1);
    const canNavigateForward = canMoveFileHistory(activeHistory, 1);
    const sharedPreviewProps = {
      canNavigateBack,
      canNavigateForward,
      onNavigateBack: handleNavigateBack,
      onNavigateForward: handleNavigateForward,
      onClose: closePreview,
      onPreviewLoadError: handlePreviewLoadError,
    };
    return (
      <div ref={fileTreeContainerRef} className="flex h-full min-h-0">
        <div className="min-h-0 flex-1" style={{ minWidth: FILE_PREVIEW_MIN_WIDTH }}>
          <FilesPanelPreview
            cwd={activeWorkspaceRoot}
            relativePath={previewPath}
            targetLine={previewTargetLine}
            executionTargetId={activeWorkspaceExecutionTargetId}
            projectName={activeProjectName}
            historyEntry={activeHistoryEntry}
            {...sharedPreviewProps}
            onScrollPositionChange={persistScrollPosition}
            onCreateAnnotation={activeThreadId ? handleCreateCodeAnnotation : undefined}
            onSearchMatch={handleSearchMatch}
          />
        </div>
        <div
          className="z-10 w-[3px] shrink-0 cursor-col-resize select-none hover:bg-primary/30"
          role="separator"
          onMouseDown={handleTreeResizeStart}
        />
        <div
          className="min-h-0 overflow-y-auto border-l border-border"
          style={{ width: fileTreeWidth }}
        >
          {treeBody}
        </div>
      </div>
    );
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
    remoteWorkspace,
    treeBody,
    activeWorkspaceExecutionTargetId,
    activeWorkspaceRoot,
  ]);

  return (
    <div ref={panelContainerRef} className="flex h-full min-h-0 flex-col">
      <FilesPanelHeader />
      <div className="min-h-0 flex-1 overflow-hidden">{panelBody}</div>
      <FilesPanelContextMenu
        contextMenuState={contextMenuState}
        workspaceRoot={activeWorkspaceRoot ?? undefined}
        threadId={workspaceRootOverride === null ? activeThreadId : null}
        onClose={closeContextMenu}
      />
    </div>
  );
});
