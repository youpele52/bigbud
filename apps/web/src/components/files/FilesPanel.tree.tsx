import type { ProjectEntry } from "@bigbud/contracts";
import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { VscodeEntryIcon } from "../chat/common/VscodeEntryIcon";
import { EMPTY_ENTRIES, entryName, type DirectoryState } from "./FilesPanel.shared";
import {
  BIGBUD_FILES_PANEL_DRAG_MIME,
  joinWorkspaceEntryPath,
  serializeFilesPanelDragEntry,
} from "./filesPanel.dnd";

interface FilesPanelTreeProps {
  entries: ReadonlyArray<ProjectEntry>;
  depth: number;
  workspaceRoot: string | null;
  previewPath: string | null;
  resolvedTheme: "light" | "dark";
  expandedDirectories: Readonly<Record<string, boolean>>;
  directoryStateByPath: Readonly<Record<string, DirectoryState>>;
  onToggleDirectory: (entry: ProjectEntry) => void;
  onOpenFile: (entry: ProjectEntry) => void;
  onOpenContextMenu: (input: {
    path: string;
    kind: "file" | "directory";
    x: number;
    y: number;
  }) => void;
}

export function renderFilesPanelTree(props: FilesPanelTreeProps): ReactNode {
  return props.entries.map((entry) => {
    const expanded = props.expandedDirectories[entry.path] ?? false;
    const nestedState = props.directoryStateByPath[entry.path];
    const name = entryName(entry);
    const isDirectory = entry.kind === "directory";

    return (
      <div key={entry.path}>
        <button
          type="button"
          draggable
          onDragStart={(event) => {
            if (!props.workspaceRoot) return;
            const absolutePath = joinWorkspaceEntryPath(props.workspaceRoot, entry.path);
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
              props.onToggleDirectory(entry);
              return;
            }
            props.onOpenFile(entry);
          }}
          onDoubleClick={() => {
            if (isDirectory) return;
            props.onOpenFile(entry);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!props.workspaceRoot) return;
            props.onOpenContextMenu({
              path: joinWorkspaceEntryPath(props.workspaceRoot, entry.path),
              kind: isDirectory ? "directory" : "file",
              x: event.clientX,
              y: event.clientY,
            });
          }}
          className={cn(
            "flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left hover:bg-accent/40",
            !isDirectory &&
              props.previewPath === entry.path &&
              "bg-accent/45 text-accent-foreground",
          )}
          style={{ paddingLeft: `${8 + props.depth * 16}px` }}
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
            theme={props.resolvedTheme}
            className="size-3.5 shrink-0"
          />
          <span className="truncate text-xs text-foreground/80">{name}</span>
        </button>
        {isDirectory && expanded ? (
          <div>
            {nestedState?.loading ? (
              <div
                className="px-2 py-1 text-xs text-muted-foreground/60"
                style={{ paddingLeft: `${24 + props.depth * 16}px` }}
              >
                Loading...
              </div>
            ) : nestedState?.error ? (
              <div
                className="px-2 py-1 text-xs text-destructive/80"
                style={{ paddingLeft: `${24 + props.depth * 16}px` }}
              >
                {nestedState.error}
              </div>
            ) : (
              renderFilesPanelTree({
                ...props,
                entries: nestedState?.entries ?? EMPTY_ENTRIES,
                depth: props.depth + 1,
              })
            )}
          </div>
        ) : null}
      </div>
    );
  });
}
