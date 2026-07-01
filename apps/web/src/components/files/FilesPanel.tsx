import { isRemoteExecutionTargetId, type ProjectEntry, type ThreadId } from "@bigbud/contracts";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isImageFilePath, isVideoFilePath } from "../../lib/workspaceFilePreview";

import { useTheme } from "../../hooks/useTheme";
import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import { useDefaultChatCwd } from "../../rpc/serverState";
import { useComposerDraftStore } from "../../stores/composer";
import { useFilesPanelStore } from "../../stores/files/filesPanel.store";
import { useProjectById, useThreadById } from "../../stores/main";
import { useUiStateStore } from "../../stores/ui";
import { FilesPanelContextMenu, useFilesPanelContextMenu } from "./FilesPanel.contextMenu";
import { FilePreview, type CodeAnnotationDraft } from "./FilePreview";
import { ImagePreview } from "./ImagePreview";
import { VideoPreview } from "./VideoPreview";
import { IpynbPreview } from "./IpynbPreview";
import { FilesPanelHeader } from "./FilesPanel.header";
import { buildAbsolutePreviewPath } from "./FilePreview.logic";
import { applyDirectoryNavigationRequest, openFilesPanelEntry } from "./FilesPanel.logic";
import { EMPTY_ENTRIES, FILE_PREVIEW_MIN_WIDTH, makeAnnotationId } from "./FilesPanel.shared";
import { renderFilesPanelTree } from "./FilesPanel.tree";
import { useFilesTreeWidth } from "./FilesPanel.treeWidth";
import { useFilesPanelDirectoryLoader } from "./useFilesPanelDirectoryLoader";
import { useFilesPanelDirectoryRefresh } from "./useFilesPanelDirectoryRefresh";

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
  const workspaceExecutionTargetId = project
    ? resolveWorkspaceExecutionTargetId(project)
    : undefined;
  const activeWorkspaceExecutionTargetId =
    workspaceRootOverride === null ? workspaceExecutionTargetId : undefined;
  const activeProjectName = workspaceRootOverride === null ? project?.name : undefined;
  const fileTreeContainerRef = useRef<HTMLDivElement>(null);
  const { fileTreeWidth, resizeTreeWidth } = useFilesTreeWidth();
  const previewPathRef = useRef<string | null>(previewPath);
  const previewPositionRef = useRef(previewPosition);
  const [expandedDirectories, setExpandedDirectories] = useState<Record<string, boolean>>({});
  const { directoryStateByPath, setDirectoryStateByPath, loadDirectory } =
    useFilesPanelDirectoryLoader({
      workspaceRoot: activeWorkspaceRoot,
      workspaceExecutionTargetId: activeWorkspaceExecutionTargetId,
      previewPathRef,
      previewPositionRef,
      setPreviewPath,
      setPreviewPosition,
    });
  const { contextMenuState, openContextMenu, closeContextMenu } = useFilesPanelContextMenu();

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
    setExpandedDirectories({});
    setDirectoryStateByPath({});
    setPreviewPath(null);
    setPreviewPosition(null);
  }, [activeWorkspaceRoot, setDirectoryStateByPath, setPreviewPath, setPreviewPosition]);

  useEffect(() => {
    if (!fileOpenRequest) return;

    setPreviewPath(fileOpenRequest.path);
    setPreviewPosition(fileOpenRequest.position);
  }, [fileOpenRequest, setPreviewPath, setPreviewPosition]);

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
  }, [directoryNavigationRequest, directoryStateByPath, loadDirectory]);

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
      openFilesPanelEntry(entry, activeWorkspaceRoot, setPreviewPath, setPreviewPosition);
    },
    [activeWorkspaceRoot, setPreviewPath, setPreviewPosition],
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
    const isIpynb = previewPath.toLowerCase().endsWith(".ipynb");
    const isImage = isImageFilePath(previewPath);
    const isVideo = isVideoFilePath(previewPath);
    const handleBack = () => {
      setPreviewPath(null);
      setPreviewPosition(null);
    };
    return (
      <div ref={fileTreeContainerRef} className="flex h-full min-h-0">
        <div className="min-h-0 flex-1" style={{ minWidth: FILE_PREVIEW_MIN_WIDTH }}>
          {isImage ? (
            <ImagePreview
              cwd={activeWorkspaceRoot}
              relativePath={previewPath}
              executionTargetId={activeWorkspaceExecutionTargetId}
              projectName={activeProjectName}
              onBack={handleBack}
            />
          ) : isVideo ? (
            <VideoPreview
              cwd={activeWorkspaceRoot}
              relativePath={previewPath}
              executionTargetId={activeWorkspaceExecutionTargetId}
              projectName={activeProjectName}
              onBack={handleBack}
            />
          ) : isIpynb ? (
            <IpynbPreview
              cwd={activeWorkspaceRoot}
              relativePath={previewPath}
              targetLine={previewTargetLine}
              executionTargetId={activeWorkspaceExecutionTargetId}
              projectName={activeProjectName}
              onBack={handleBack}
              onCreateAnnotation={activeThreadId ? handleCreateCodeAnnotation : undefined}
            />
          ) : (
            <FilePreview
              cwd={activeWorkspaceRoot}
              relativePath={previewPath}
              targetLine={previewTargetLine}
              executionTargetId={activeWorkspaceExecutionTargetId}
              projectName={activeProjectName}
              onBack={handleBack}
              onCreateAnnotation={activeThreadId ? handleCreateCodeAnnotation : undefined}
            />
          )}
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
    fileTreeWidth,
    handleCreateCodeAnnotation,
    handleTreeResizeStart,
    previewPath,
    previewTargetLine,
    activeProjectName,
    remoteWorkspace,
    setPreviewPath,
    setPreviewPosition,
    treeBody,
    activeWorkspaceExecutionTargetId,
    activeWorkspaceRoot,
  ]);

  const activeFilePath = useMemo(() => {
    if (!activeWorkspaceRoot || !previewPath) {
      return null;
    }

    return buildAbsolutePreviewPath(activeWorkspaceRoot, previewPath);
  }, [activeWorkspaceRoot, previewPath]);

  return (
    <>
      <FilesPanelHeader workspaceRoot={activeWorkspaceRoot} activeFilePath={activeFilePath} />
      <div className="min-h-0 flex-1 overflow-hidden">{panelBody}</div>
      <FilesPanelContextMenu
        contextMenuState={contextMenuState}
        workspaceRoot={activeWorkspaceRoot ?? undefined}
        onClose={closeContextMenu}
      />
    </>
  );
});
