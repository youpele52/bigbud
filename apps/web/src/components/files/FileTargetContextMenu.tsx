import { useCallback, useEffect, useMemo, useState } from "react";

import { openPathInPreferredApp } from "../../models/editor";
import { readNativeApi } from "../../rpc/nativeApi";
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
import { createSharedFileActionItems, type SharedFileActionId } from "./FileActionsMenu.shared";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
}: FileTargetContextMenuProps) {
  const [open, setOpen] = useState(false);

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
    openPathInBrowserPanelIfSupported(targetPath, workspaceRoot);
  }, [targetPath, workspaceRoot]);

  const handleOpenInFileViewer = useCallback(() => {
    if (!targetPath) return;
    openPathInFilesPanelIfSupported(targetPath, workspaceRoot);
  }, [targetPath, workspaceRoot]);

  const handleOpenDirectoryInternally = useCallback(() => {
    if (!targetPath) return;
    openDirectoryInFilesPanelIfSupported(targetPath, workspaceRoot);
  }, [targetPath, workspaceRoot]);

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
  const sharedActions = useMemo(
    () =>
      createSharedFileActionItems({
        canSelectAll: false,
        canOpenExternally: kind === "file" || kind === "directory",
        canCopyRelativePath: Boolean(menuOptions.relativePath),
        canCopyPath: true,
      }),
    [kind, menuOptions.relativePath],
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
          {menuOptions.canOpenInBrowser ? (
            <DropdownMenuItem onClick={handleOpenInBrowser}>Open in browser</DropdownMenuItem>
          ) : null}
          {menuOptions.canOpenInFileViewer ? (
            <DropdownMenuItem onClick={handleOpenInFileViewer}>
              Open in file viewer
            </DropdownMenuItem>
          ) : null}
          {menuOptions.canOpenDirectoryInternally ? (
            <DropdownMenuItem onClick={handleOpenDirectoryInternally}>
              Open internally
            </DropdownMenuItem>
          ) : null}
          {sharedActions.map((item) => (
            <DropdownMenuItem key={item.id} onClick={() => handleSharedAction(item.id)}>
              {item.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      ) : null}
    </DropdownMenu>
  );
}
