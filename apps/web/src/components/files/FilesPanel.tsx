import { isRemoteExecutionTargetId, type ProjectEntry, type ThreadId } from "@bigbud/contracts";
import { ChevronRightIcon } from "lucide-react";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useTheme } from "../../hooks/useTheme";
import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import { isCodeRelatedFilePath, openPathInPreferredApp } from "../../models/editor";
import { readNativeApi } from "../../rpc/nativeApi";
import { useDefaultChatCwd } from "../../rpc/serverState";
import { useComposerDraftStore } from "../../stores/composer";
import { useFilesPanelStore } from "../../stores/files/filesPanel.store";
import { useProjectById, useThreadById } from "../../stores/main";
import { useUiStateStore } from "../../stores/ui";
import { VscodeEntryIcon } from "../chat/common/VscodeEntryIcon";
import { FilePreview, type CodeAnnotationDraft } from "./FilePreview";
import { FilesPanelHeader } from "./FilesPanel.header";
import {
  EMPTY_ENTRIES,
  entryName,
  makeAnnotationId,
  type DirectoryState,
} from "./FilesPanel.shared";
import { useFilesTreeWidth } from "./FilesPanel.treeWidth";
import { useFilesPanelDirectoryRefresh } from "./useFilesPanelDirectoryRefresh";
import {
  BIGBUD_FILES_PANEL_DRAG_MIME,
  joinWorkspaceEntryPath,
  serializeFilesPanelDragEntry,
} from "./filesPanel.dnd";

interface FilesPanelProps {
  activeThreadId?: ThreadId | null;
}

export const FilesPanelContent = memo(function FilesPanelContent({
  activeThreadId,
}: FilesPanelProps) {
  const previewPath = useFilesPanelStore((state) => state.previewPath);
  const previewPosition = useFilesPanelStore((state) => state.previewPosition);
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
        setDirectoryStateByPath((current) => ({
          ...current,
          [relativePath]: {
            entries: result.entries,
            loading: false,
            error: null,
          },
        }));
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
    [directoryStateByPath, workspaceExecutionTargetId, workspaceRoot],
  );

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
      if (isCodeRelatedFilePath(entry.path)) {
        setPreviewPath(entry.path);
        setPreviewPosition(null);
        return;
      }
      const absolutePath = joinWorkspaceEntryPath(workspaceRoot, entry.path);
      const api = readNativeApi();
      if (!api) return;
      void openPathInPreferredApp(api, absolutePath).catch((error) => {
        console.error("Failed to open file:", error);
      });
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

  const renderEntries = useCallback(
    (entries: ReadonlyArray<ProjectEntry>, depth: number): ReactNode =>
      entries.map((entry) => {
        const expanded = expandedDirectories[entry.path] ?? false;
        const nestedState = directoryStateByPath[entry.path];
        const name = entryName(entry);
        const isDirectory = entry.kind === "directory";
        return (
          <div key={entry.path}>
            <button
              type="button"
              draggable
              onDragStart={(event) => {
                if (!workspaceRoot) return;
                const absolutePath = joinWorkspaceEntryPath(workspaceRoot, entry.path);
                event.dataTransfer.effectAllowed = "copy";
                event.dataTransfer.setData(
                  BIGBUD_FILES_PANEL_DRAG_MIME,
                  serializeFilesPanelDragEntry({
                    name,
                    path: absolutePath,
                    entryKind: isDirectory ? "directory" : "file",
                  }),
                );
                event.dataTransfer.setData("text/plain", absolutePath);
              }}
              onClick={() => {
                if (isDirectory) {
                  handleToggleDirectory(entry);
                  return;
                }
                handleOpenFile(entry);
              }}
              onDoubleClick={() => {
                if (isDirectory) return;
                handleOpenFile(entry);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const api = readNativeApi();
                if (!api || !workspaceRoot) return;
                const absolutePath = joinWorkspaceEntryPath(workspaceRoot, entry.path);
                void api.contextMenu
                  .show([{ id: "copy-path", label: "Copy Path" }], {
                    x: event.clientX,
                    y: event.clientY,
                  })
                  .then((action) => {
                    if (action === "copy-path") {
                      copyToClipboard(absolutePath, { path: absolutePath });
                    }
                  });
              }}
              className={cn(
                "flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left hover:bg-accent/40",
                !isDirectory && previewPath === entry.path && "bg-accent/45 text-accent-foreground",
              )}
              style={{ paddingLeft: `${8 + depth * 16}px` }}
            >
              {isDirectory ? (
                <ChevronRightIcon
                  className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")}
                />
              ) : (
                <span className="size-3 shrink-0" />
              )}
              <VscodeEntryIcon
                pathValue={entry.path}
                kind={isDirectory ? "directory" : "file"}
                theme={resolvedTheme}
                className="size-3.5 shrink-0"
              />
              <span className="truncate text-xs text-foreground/80">{name}</span>
            </button>
            {isDirectory && expanded ? (
              <div>
                {nestedState?.loading ? (
                  <div
                    className="px-2 py-1 text-xs text-muted-foreground/60"
                    style={{ paddingLeft: `${24 + depth * 16}px` }}
                  >
                    Loading...
                  </div>
                ) : nestedState?.error ? (
                  <div
                    className="px-2 py-1 text-xs text-destructive/80"
                    style={{ paddingLeft: `${24 + depth * 16}px` }}
                  >
                    {nestedState.error}
                  </div>
                ) : (
                  renderEntries(nestedState?.entries ?? EMPTY_ENTRIES, depth + 1)
                )}
              </div>
            ) : null}
          </div>
        );
      }),
    [
      copyToClipboard,
      directoryStateByPath,
      expandedDirectories,
      handleOpenFile,
      handleToggleDirectory,
      previewPath,
      resolvedTheme,
      workspaceRoot,
    ],
  );

  const treeBody = useMemo(() => {
    if (rootDirectoryState?.loading) {
      return <div className="p-3 text-sm text-muted-foreground/70">Loading files...</div>;
    }
    if (rootDirectoryState?.error) {
      return <div className="p-3 text-sm text-destructive/80">{rootDirectoryState.error}</div>;
    }
    return <div className="space-y-0.5 p-2">{renderEntries(sortedRootEntries, 0)}</div>;
  }, [renderEntries, rootDirectoryState, sortedRootEntries]);

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
    return (
      <div ref={fileTreeContainerRef} className="flex h-full min-h-0">
        <div className="min-h-0 min-w-0 flex-1">
          <FilePreview
            cwd={workspaceRoot}
            relativePath={previewPath}
            targetLine={previewTargetLine}
            executionTargetId={workspaceExecutionTargetId}
            projectName={project?.name}
            onBack={() => {
              setPreviewPath(null);
              setPreviewPosition(null);
            }}
            onCreateAnnotation={activeThreadId ? handleCreateCodeAnnotation : undefined}
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
    </>
  );
});
