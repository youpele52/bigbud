import { isRemoteExecutionTargetId, type ProjectEntry, type ThreadId } from "@bigbud/contracts";
import { ChevronRightIcon, FolderIcon, FolderOpenIcon, XIcon } from "lucide-react";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "../ui/button";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { openPathInPreferredApp } from "../../models/editor";
import { readNativeApi } from "../../rpc/nativeApi";
import { useDefaultChatCwd } from "../../rpc/serverState";
import { useFilesPanelStore } from "../../stores/files/filesPanel.store";
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
import { closeFilesPanel } from "../../stores/files/filesPanel.coordinator";
import { RightPanelShell } from "../right-panel/RightPanelShell";
import { useRightPanelWidth } from "../right-panel/useRightPanelWidth";

interface FilesPanelProps {
  activeThreadId?: ThreadId | null;
}

interface DirectoryState {
  entries: ReadonlyArray<ProjectEntry>;
  loading: boolean;
  error: string | null;
}

const EMPTY_ENTRIES: ReadonlyArray<ProjectEntry> = [];
const FILES_PANEL_MIN_WIDTH = 320;
const FILES_PANEL_WIDTH_STORAGE_KEY = "files_panel_width";

function entryName(entry: ProjectEntry): string {
  const segments = entry.path.split("/");
  return segments.at(-1) ?? entry.path;
}

export const FilesPanel = memo(function FilesPanel({ activeThreadId }: FilesPanelProps) {
  const open = useFilesPanelStore((state) => state.open);
  const thread = useThreadById(activeThreadId ?? null);
  const selectedProjectId = useUiStateStore((state) => state.selectedProjectId);
  const project = useProjectById(thread?.projectId ?? selectedProjectId ?? null);
  const { resolvedTheme } = useTheme();
  const defaultChatCwd = useDefaultChatCwd();
  const { copyToClipboard } = useCopyToClipboard<{ path: string }>();
  const workspaceRoot = thread?.worktreePath ?? project?.cwd ?? defaultChatCwd ?? null;
  const workspaceExecutionTargetId = project
    ? resolveWorkspaceExecutionTargetId(project)
    : undefined;
  const { panelWidth, onResizePointerDown } = useRightPanelWidth({
    minWidth: FILES_PANEL_MIN_WIDTH,
    storageKey: FILES_PANEL_WIDTH_STORAGE_KEY,
  });
  const [expandedDirectories, setExpandedDirectories] = useState<Record<string, boolean>>({});
  const [directoryStateByPath, setDirectoryStateByPath] = useState<Record<string, DirectoryState>>(
    {},
  );

  useEffect(() => {
    setExpandedDirectories({});
    setDirectoryStateByPath({});
  }, [workspaceRoot]);

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
  const showPanel = open && Boolean(workspaceRoot);
  const sortedRootEntries = rootDirectoryState?.entries ?? EMPTY_ENTRIES;

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
      const absolutePath = joinWorkspaceEntryPath(workspaceRoot, entry.path);
      const api = readNativeApi();
      if (!api) return;
      void openPathInPreferredApp(api, absolutePath).catch((error) => {
        console.error("Failed to open file:", error);
      });
    },
    [workspaceRoot],
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
                }
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
              className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left hover:bg-accent/40"
              style={{ paddingLeft: `${8 + depth * 16}px` }}
            >
              {isDirectory ? (
                <ChevronRightIcon
                  className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")}
                />
              ) : (
                <span className="size-3 shrink-0" />
              )}
              {isDirectory ? (
                expanded ? (
                  <FolderOpenIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
                ) : (
                  <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
                )
              ) : (
                <VscodeEntryIcon
                  pathValue={entry.path}
                  kind="file"
                  theme={resolvedTheme}
                  className="size-3.5 shrink-0"
                />
              )}
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
      resolvedTheme,
      workspaceRoot,
    ],
  );

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
    if (rootDirectoryState?.loading) {
      return <div className="p-3 text-sm text-muted-foreground/70">Loading files...</div>;
    }
    if (rootDirectoryState?.error) {
      return <div className="p-3 text-sm text-destructive/80">{rootDirectoryState.error}</div>;
    }
    return <div className="space-y-0.5 p-2">{renderEntries(sortedRootEntries, 0)}</div>;
  }, [remoteWorkspace, renderEntries, rootDirectoryState, sortedRootEntries, workspaceRoot]);

  return (
    <RightPanelShell
      open={showPanel}
      width={panelWidth}
      onResizePointerDown={onResizePointerDown}
      resizeAriaLabel="Resize files panel"
    >
      <div
        className={cn(
          "flex items-center justify-between border-b border-border px-3",
          isElectron ? "h-[52px]" : "py-2",
        )}
      >
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Files</p>
          <p
            className="truncate text-[11px] text-muted-foreground/65"
            title={workspaceRoot ?? undefined}
          >
            {workspaceRoot ?? "No workspace"}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="[-webkit-app-region:no-drag]"
          onClick={closeFilesPanel}
          aria-label="Close files panel"
        >
          <XIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{panelBody}</div>
    </RightPanelShell>
  );
});
