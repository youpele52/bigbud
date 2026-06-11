import { isRemoteExecutionTargetId, type ProjectEntry, type ThreadId } from "@bigbud/contracts";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useTheme } from "../../hooks/useTheme";
import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import { useDefaultChatCwd } from "../../rpc/serverState";
import { readNativeApi } from "../../rpc/nativeApi";
import { useComposerDraftStore } from "../../stores/composer";
import { useFilesPanelStore } from "../../stores/files/filesPanel.store";
import { useProjectById, useThreadById } from "../../stores/main";
import { useUiStateStore } from "../../stores/ui";
import { FilesPanelContextMenu, useFilesPanelContextMenu } from "./FilesPanel.contextMenu";
import { FilePreview, type CodeAnnotationDraft } from "./FilePreview";
import { IpynbPreview } from "./IpynbPreview";
import { FilesPanelHeader } from "./FilesPanel.header";
import {
  applyDirectoryNavigationRequest,
  openFilesPanelEntry,
  reconcilePreviewPathAfterDirectoryRefresh,
} from "./FilesPanel.logic";
import { EMPTY_ENTRIES, makeAnnotationId, type DirectoryState } from "./FilesPanel.shared";
import { renderFilesPanelTree } from "./FilesPanel.tree";
import { useFilesTreeWidth } from "./FilesPanel.treeWidth";
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
  const { copyToClipboard } = useCopyToClipboard<{ path: string }>();
  const addAnnotation = useComposerDraftStore((state) => state.addAnnotation);
  const workspaceRoot = thread?.worktreePath ?? project?.cwd ?? defaultChatCwd ?? null;
  const workspaceExecutionTargetId = project
    ? resolveWorkspaceExecutionTargetId(project)
    : undefined;
  const fileTreeContainerRef = useRef<HTMLDivElement>(null);
  const { fileTreeWidth, resizeTreeWidth } = useFilesTreeWidth();
  const [expandedDirectories, setExpandedDirectories] = useState<Record<string, boolean>>({});
  const [directoryStateByPath, setDirectoryStateByPath] = useState<Record<string, DirectoryState>>(
    {},
  );
  const { contextMenuState, openContextMenu, closeContextMenu } = useFilesPanelContextMenu();
  const previewPathRef = useRef<string | null>(previewPath);
  const previewPositionRef = useRef(previewPosition);

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
  }, [setPreviewPath, setPreviewPosition, workspaceRoot]);

  useEffect(() => {
    if (!fileOpenRequest) return;

    setPreviewPath(fileOpenRequest.path);
    setPreviewPosition(fileOpenRequest.position);
  }, [fileOpenRequest, setPreviewPath, setPreviewPosition]);

  const loadDirectory = useCallback(
    async (relativePath: string, options?: { readonly force?: boolean }) => {
      if (!workspaceRoot) return;
      const existing = directoryStateByPath[relativePath];
      if (existing?.loading) return;
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
      }
    },
    [
      directoryStateByPath,
      setPreviewPath,
      setPreviewPosition,
      workspaceExecutionTargetId,
      workspaceRoot,
    ],
  );

  useEffect(() => {
    if (!directoryNavigationRequest) return;

    applyDirectoryNavigationRequest(
      directoryNavigationRequest.path,
      directoryStateByPath,
      loadDirectory,
      setExpandedDirectories,
    );
  }, [directoryNavigationRequest, directoryStateByPath, loadDirectory]);

  useFilesPanelDirectoryRefresh({
    workspaceRoot,
    workspaceExecutionTargetId,
    expandedDirectories,
    directoryStateByPath,
    loadDirectory,
  });

  useEffect(() => {
    if (!workspaceRoot) return;
    if (directoryStateByPath[""] !== undefined) return;
    void loadDirectory("");
  }, [directoryStateByPath, loadDirectory, workspaceRoot]);

  const rootDirectoryState = directoryStateByPath[""];
  const remoteWorkspace = isRemoteExecutionTargetId(workspaceExecutionTargetId);
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
      if (!workspaceRoot) return;
      openFilesPanelEntry(entry, workspaceRoot, setPreviewPath, setPreviewPosition);
    },
    [setPreviewPath, setPreviewPosition, workspaceRoot],
  );

  const handleCreateCodeAnnotation = useCallback(
    (annotation: CodeAnnotationDraft) => {
      if (!activeThreadId || !workspaceRoot || !previewPath) return;
      addAnnotation(activeThreadId, {
        id: makeAnnotationId(),
        kind: "code",
        comment: annotation.comment,
        intent: annotation.intent,
        createdAt: new Date().toISOString(),
        file: {
          ...(project?.name ? { projectName: project.name } : {}),
          cwd: workspaceRoot,
          relativePath: previewPath,
        },
        selection: {
          startLine: annotation.startLine,
          endLine: annotation.endLine,
          text: annotation.text,
        },
      });
    },
    [activeThreadId, addAnnotation, previewPath, project?.name, workspaceRoot],
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
          workspaceRoot,
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
    workspaceRoot,
  ]);

  const panelBody = useMemo(() => {
    if (!workspaceRoot) {
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
    const handleBack = () => {
      setPreviewPath(null);
      setPreviewPosition(null);
    };
    return (
      <div ref={fileTreeContainerRef} className="flex h-full min-h-0">
        <div className="min-h-0 min-w-0 flex-1">
          {isIpynb ? (
            <IpynbPreview
              cwd={workspaceRoot}
              relativePath={previewPath}
              targetLine={previewTargetLine}
              executionTargetId={workspaceExecutionTargetId}
              projectName={project?.name}
              onBack={handleBack}
              onCreateAnnotation={activeThreadId ? handleCreateCodeAnnotation : undefined}
            />
          ) : (
            <FilePreview
              cwd={workspaceRoot}
              relativePath={previewPath}
              targetLine={previewTargetLine}
              executionTargetId={workspaceExecutionTargetId}
              projectName={project?.name}
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
    project?.name,
    remoteWorkspace,
    setPreviewPath,
    setPreviewPosition,
    treeBody,
    workspaceExecutionTargetId,
    workspaceRoot,
  ]);

  return (
    <>
      <FilesPanelHeader workspaceRoot={workspaceRoot} />
      <div className="min-h-0 flex-1 overflow-hidden">{panelBody}</div>
      <FilesPanelContextMenu
        contextMenuState={contextMenuState}
        workspaceRoot={workspaceRoot ?? undefined}
        onClose={closeContextMenu}
        onCopyPath={(path) => copyToClipboard(path, { path })}
      />
    </>
  );
});
