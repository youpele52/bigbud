import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

import { openPathInPreferredApp } from "../../models/editor";
import { newCommandId } from "../../lib/utils";
import { readNativeApi } from "../../rpc/nativeApi";
import { isRemoteExecutionTargetId, type ThreadId } from "@bigbud/contracts";
import {
  canOpenDirectoryInFilesPanel,
  canOpenPathInBrowserPanel,
  canOpenPathInFilesPanel,
  openDirectoryInFilesPanelIfSupported,
  openPathInBrowserPanelIfSupported,
  openPathInFilesPanelIfSupported,
  resolveWorkspaceRelativeEntryPath,
} from "../../stores/files/filesPanel.open";
import { copyTextToClipboard } from "~/lib/clipboard/copyText";
import type { SharedFileActionId } from "./FileActionsMenu.shared";
import {
  buildFileTargetMenuGroups,
  type FileTargetMenuItemId,
} from "./FileTargetContextMenu.logic";
import { useFileOpenTarget } from "./fileOpenTarget.context";
import { dispatchPathCheckpointAction } from "./pathCheckpoint.action";
import { toastManager } from "../ui/toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/menu";

type MenuTargetKind = "file" | "directory";

type ContextMenuPosition = {
  x: number;
  y: number;
};

interface FileTargetContextMenuProps {
  targetPath: string | null;
  workspaceRoot: string | undefined;
  kind: MenuTargetKind | null;
  position: ContextMenuPosition | null;
  onClose: () => void;
  threadId?: ThreadId | null | undefined;
  /** Shows Delete… (Files panel only); `deleteDisabledReason` null means it is allowed. */
  onDelete?: ((target: { relativePath: string; kind: MenuTargetKind }) => void) | undefined;
  deleteDisabledReason?: string | null | undefined;
}

function createVirtualAnchor(position: ContextMenuPosition) {
  return {
    getBoundingClientRect: () => ({
      width: 0,
      height: 0,
      x: position.x,
      y: position.y,
      top: position.y,
      right: position.x,
      bottom: position.y,
      left: position.x,
      toJSON: () => undefined,
    }),
  };
}

export function FileTargetContextMenu({
  targetPath,
  workspaceRoot,
  kind,
  position,
  onClose,
  threadId,
  onDelete,
  deleteDisabledReason,
}: FileTargetContextMenuProps) {
  const [open, setOpen] = useState(false);
  const fileOpenTarget = useFileOpenTarget();

  useEffect(() => {
    setOpen(Boolean(targetPath && kind && position));
  }, [kind, position, targetPath]);

  const anchor = useMemo(() => (position ? createVirtualAnchor(position) : undefined), [position]);

  const menuOptions = useMemo(() => {
    if (!targetPath || !kind) {
      return {
        canOpenInBrowser: false,
        canOpenInFileViewer: false,
        canOpenDirectoryInternally: false,
        relativePath: null,
      };
    }

    if (kind === "directory") {
      return {
        canOpenInBrowser: false,
        canOpenInFileViewer: false,
        canOpenDirectoryInternally: canOpenDirectoryInFilesPanel(targetPath, workspaceRoot),
        relativePath: resolveWorkspaceRelativeEntryPath(targetPath, workspaceRoot),
      };
    }

    return {
      canOpenInBrowser: canOpenPathInBrowserPanel(targetPath, workspaceRoot),
      canOpenInFileViewer: canOpenPathInFilesPanel(targetPath, workspaceRoot),
      canOpenDirectoryInternally: false,
      relativePath: resolveWorkspaceRelativeEntryPath(targetPath, workspaceRoot),
    };
  }, [kind, targetPath, workspaceRoot]);

  const handleOpenInBrowser = useCallback(() => {
    if (!targetPath) return;
    openPathInBrowserPanelIfSupported(targetPath, workspaceRoot, fileOpenTarget);
  }, [fileOpenTarget, targetPath, workspaceRoot]);

  const handleOpenInFileViewer = useCallback(() => {
    if (!targetPath) return;
    openPathInFilesPanelIfSupported(targetPath, workspaceRoot, fileOpenTarget);
  }, [fileOpenTarget, targetPath, workspaceRoot]);

  const handleOpenDirectoryInternally = useCallback(() => {
    if (!targetPath) return;
    openDirectoryInFilesPanelIfSupported(targetPath, workspaceRoot, fileOpenTarget);
  }, [fileOpenTarget, targetPath, workspaceRoot]);

  const handleSharedAction = useCallback(
    (action: SharedFileActionId) => {
      if (!targetPath) {
        return;
      }

      if (action === "open-externally") {
        const api = readNativeApi();
        if (!api) {
          return;
        }
        void openPathInPreferredApp(api, targetPath).catch((error) => {
          console.error(`Failed to open ${kind ?? "entry"} externally:`, error);
        });
        return;
      }

      if (action === "copy-relative-path") {
        if (!menuOptions.relativePath) {
          return;
        }
        void copyTextToClipboard(menuOptions.relativePath);
        return;
      }

      if (action === "copy-path") {
        void copyTextToClipboard(targetPath);
      }
    },
    [kind, menuOptions.relativePath, targetPath],
  );
  const handlePathCheckpoint = useCallback(
    async (operation: "capture" | "restore") => {
      if (!threadId || !menuOptions.relativePath) return;
      const api = readNativeApi();
      if (!api) return;
      try {
        await dispatchPathCheckpointAction({
          operation,
          commandId: newCommandId(),
          threadId,
          path: menuOptions.relativePath,
          api,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: `Unable to ${operation} path checkpoint`,
          description: error instanceof Error ? error.message : "The request could not be sent.",
        });
      }
    },
    [menuOptions.relativePath, threadId],
  );
  const menuGroups = useMemo(
    () =>
      buildFileTargetMenuGroups({
        ...menuOptions,
        // A remote path only exists on its host, never in an app on this computer.
        canOpenExternally:
          (kind === "file" || kind === "directory") && !isRemoteExecutionTargetId(fileOpenTarget),
        canCopyRelativePath: Boolean(menuOptions.relativePath),
        canCopyPath: true,
        canUsePathCheckpoints: Boolean(threadId && menuOptions.relativePath),
        deleteDisabledReason:
          onDelete && menuOptions.relativePath ? (deleteDisabledReason ?? null) : undefined,
      }),
    [deleteDisabledReason, fileOpenTarget, kind, menuOptions, onDelete, threadId],
  );
  const handleItem = useCallback(
    (id: FileTargetMenuItemId) => {
      if (id === "open-in-browser") return handleOpenInBrowser();
      if (id === "open-in-file-viewer") return handleOpenInFileViewer();
      if (id === "open-internally") return handleOpenDirectoryInternally();
      if (id === "capture-checkpoint") return void handlePathCheckpoint("capture");
      if (id === "restore-checkpoint") return void handlePathCheckpoint("restore");
      if (id === "delete") {
        if (menuOptions.relativePath && kind)
          onDelete?.({ relativePath: menuOptions.relativePath, kind });
        return;
      }
      handleSharedAction(id);
    },
    [
      handleOpenDirectoryInternally,
      handleOpenInBrowser,
      handleOpenInFileViewer,
      handlePathCheckpoint,
      handleSharedAction,
      kind,
      menuOptions.relativePath,
      onDelete,
    ],
  );

  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          onClose();
        }
      }}
      open={open}
    >
      <DropdownMenuTrigger
        render={<button type="button" className="hidden" aria-hidden="true" tabIndex={-1} />}
      />
      {anchor && targetPath ? (
        <DropdownMenuContent align="start" anchor={anchor} side="bottom" sideOffset={2}>
          {menuGroups.map((group, index) => (
            <Fragment key={group[0]?.id ?? index}>
              {index > 0 ? <DropdownMenuSeparator /> : null}
              {group.map((item) => (
                <DropdownMenuItem
                  key={item.id}
                  data-file-menu-item={item.id}
                  variant={item.destructive ? "destructive" : "default"}
                  className={
                    item.destructive ? "text-destructive focus:text-destructive" : undefined
                  }
                  disabled={item.disabledReason !== undefined}
                  title={item.disabledReason}
                  onClick={() => handleItem(item.id)}
                >
                  {item.label}
                </DropdownMenuItem>
              ))}
            </Fragment>
          ))}
        </DropdownMenuContent>
      ) : null}
    </DropdownMenu>
  );
}
