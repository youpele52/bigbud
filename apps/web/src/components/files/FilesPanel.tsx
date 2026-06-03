import { isRemoteExecutionTargetId, type ProjectEntry, type ThreadId } from "@bigbud/contracts";
import { ChevronRightIcon } from "lucide-react";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { isCodeRelatedFilePath, openPathInPreferredApp } from "../../models/editor";
import { readNativeApi } from "../../rpc/nativeApi";
import { useDefaultChatCwd } from "../../rpc/serverState";
import { useFilesPanelStore } from "../../stores/files/filesPanel.store";
import { useComposerDraftStore } from "../../stores/composer";
import { useProjectById, useThreadById } from "../../stores/main";
import { useUiStateStore } from "../../stores/ui";
import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import { cn } from "~/lib/utils";
import { isElectron } from "../../config/env";
import {
  BIGBUD_FILES_PANEL_DRAG_MIME,
  joinWorkspaceEntryPath,
  serializeFilesPanelDragEntry,
} from "./filesPanel.dnd";
import { VscodeEntryIcon } from "../chat/common/VscodeEntryIcon";
import { useTheme } from "../../hooks/useTheme";
import { closeFilesPanel, openFilesPanel } from "../../stores/files/filesPanel.coordinator";
import { closeBrowserPanel, openBrowserPanel } from "../../stores/browser/browserPanel.actions";
import { useRightPanelTabsStore } from "../../stores/rightPanel/rightPanelTabs.store";
import {
  closeTerminalPanel,
  openTerminalPanel,
} from "../../stores/terminal/terminalPanel.coordinator";
import { RightPanelShell } from "../right-panel/RightPanelShell";
import { RightPanelTabs } from "../right-panel/RightPanelTabs";
import { useRightPanelWidth } from "../right-panel/useRightPanelWidth";
import { FilePreview, type CodeAnnotationDraft } from "./FilePreview";

interface FilesPanelProps {
  activeThreadId?: ThreadId | null;
}

interface DirectoryState {
  entries: ReadonlyArray<ProjectEntry>;
  loading: boolean;
  error: string | null;
}

const EMPTY_ENTRIES: ReadonlyArray<ProjectEntry> = [];
const FILES_PANEL_MIN_WIDTH = 520;
const FILES_PANEL_WIDTH_STORAGE_KEY = "files_panel_width";
const FILES_TREE_WIDTH_STORAGE_KEY = "files_tree_width";
const FILES_TREE_MIN_WIDTH = 220;
const FILES_TREE_MAX_WIDTH_FACTOR = 0.6;
const FILES_TREE_DEFAULT_WIDTH = 280;

function entryName(entry: ProjectEntry): string {
  const segments = entry.path.split("/");
  return segments.at(-1) ?? entry.path;
}

function makeAnnotationId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `code-annotation-${Date.now()}`;
}

export const FilesPanel = memo(function FilesPanel({ activeThreadId }: FilesPanelProps) {
  const open = useFilesPanelStore((state) => state.open);
  const previewPath = useFilesPanelStore((state) => state.previewPath);
  const previewPosition = useFilesPanelStore((state) => state.previewPosition);
  const setPreviewPath = useFilesPanelStore((state) => state.setPreviewPath);
  const setPreviewPosition = useFilesPanelStore((state) => state.setPreviewPosition);
  const activeTab = useRightPanelTabsStore((state) => state.activeKind);
  const rightPanelOpen = useRightPanelTabsStore((state) => state.rightPanelOpen);
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
  const { panelWidth, onResizePointerDown } = useRightPanelWidth({
    minWidth: FILES_PANEL_MIN_WIDTH,
    storageKey: FILES_PANEL_WIDTH_STORAGE_KEY,
  });
  const fileTreeContainerRef = useRef<HTMLDivElement>(null);
  const [fileTreeWidth, setFileTreeWidth] = useState(() => {
    const stored = Number.parseInt(localStorage.getItem(FILES_TREE_WIDTH_STORAGE_KEY) ?? "", 10);
    return Number.isFinite(stored) && stored >= FILES_TREE_MIN_WIDTH
      ? stored
      : FILES_TREE_DEFAULT_WIDTH;
  });

  const handleTreeResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const container = fileTreeContainerRef.current;
      if (!container) return;

      const startX = e.clientX;
      const startWidth = fileTreeWidth;
      const maxWidth = container.getBoundingClientRect().width * FILES_TREE_MAX_WIDTH_FACTOR;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const deltaX = moveEvent.clientX - startX;
        const newWidth = Math.max(FILES_TREE_MIN_WIDTH, Math.min(maxWidth, startWidth - deltaX));
        setFileTreeWidth(newWidth);
        localStorage.setItem(FILES_TREE_WIDTH_STORAGE_KEY, String(newWidth));
      };

      const handleMouseUp = () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [fileTreeWidth],
  );
  const [expandedDirectories, setExpandedDirectories] = useState<Record<string, boolean>>({});
  const [directoryStateByPath, setDirectoryStateByPath] = useState<Record<string, DirectoryState>>(
    {},
  );
  useEffect(() => {
    setExpandedDirectories({});
    setDirectoryStateByPath({});
    setPreviewPath(null);
    setPreviewPosition(null);
  }, [setPreviewPath, setPreviewPosition, workspaceRoot]);

  const loadDirectory = useCallback(
    async (relativePath: string) => {
      if (!workspaceRoot) return;
      const existing = directoryStateByPath[relativePath];
      if (existing?.loading) return;

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

  useEffect(() => {
    if (!open || !workspaceRoot) return;
    if (directoryStateByPath[""] !== undefined) return;
    void loadDirectory("");
  }, [directoryStateByPath, loadDirectory, open, workspaceRoot]);

  const rootDirectoryState = directoryStateByPath[""];
  const remoteWorkspace = isRemoteExecutionTargetId(workspaceExecutionTargetId);
  const showPanel = open && Boolean(workspaceRoot) && activeTab === "files" && rightPanelOpen;
  const sortedRootEntries = rootDirectoryState?.entries ?? EMPTY_ENTRIES;
  const previewTargetLine = previewPosition?.line;

  const handleToggleDirectory = useCallback(
    (entry: ProjectEntry) => {
      setExpandedDirectories((current) => {
        const nextExpanded = !(current[entry.path] ?? false);
        return { ...current, [entry.path]: nextExpanded };
      });
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
      directoryStateByPath,
      expandedDirectories,
      copyToClipboard,
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
    <RightPanelShell
      open={showPanel}
      width={panelWidth}
      onResizePointerDown={onResizePointerDown}
      resizeAriaLabel="Resize files panel"
    >
      <RightPanelTabs
        browserShortcutLabel={null}
        filesShortcutLabel={null}
        hasActiveProject={Boolean(workspaceRoot)}
        onCloseBrowser={closeBrowserPanel}
        onCloseFiles={closeFilesPanel}
        onCloseTerminal={closeTerminalPanel}
        onOpenBrowser={openBrowserPanel}
        onOpenFiles={openFilesPanel}
        onOpenTerminal={openTerminalPanel}
        terminalAvailable={Boolean(workspaceRoot)}
        terminalShortcutLabel={null}
      />
      <div className={cn("border-b border-border px-3", isElectron ? "py-2.5" : "py-2")}>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Files</p>
          <p
            className="truncate text-[11px] text-muted-foreground/65"
            title={workspaceRoot ?? undefined}
          >
            {workspaceRoot ?? "No workspace"}
          </p>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{panelBody}</div>
    </RightPanelShell>
  );
});
