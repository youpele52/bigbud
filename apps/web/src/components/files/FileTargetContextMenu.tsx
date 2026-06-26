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
} from "../../stores/files/filesPanel.open";
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
  onCopyPath?: (path: string) => void;
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
  onCopyPath,
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
      };
    }

    if (kind === "directory") {
      return {
        canOpenInBrowser: false,
        canOpenInFileViewer: false,
        canOpenDirectoryInternally: canOpenDirectoryInFilesPanel(targetPath, workspaceRoot),
      };
    }

    return {
      canOpenInBrowser: canOpenPathInBrowserPanel(targetPath, workspaceRoot),
      canOpenInFileViewer: canOpenPathInFilesPanel(targetPath, workspaceRoot),
      canOpenDirectoryInternally: false,
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

  const handleOpenExternally = useCallback(() => {
    if (!targetPath) return;
    const api = readNativeApi();
    if (!api) return;
    void openPathInPreferredApp(api, targetPath).catch((error) => {
      console.error(`Failed to open ${kind ?? "entry"} externally:`, error);
    });
  }, [kind, targetPath]);

  const handleCopyPath = useCallback(() => {
    if (!targetPath || !onCopyPath) return;
    onCopyPath(targetPath);
  }, [onCopyPath, targetPath]);

  const showOpenExternally = kind === "file";

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
          {showOpenExternally || kind === "directory" ? (
            <DropdownMenuItem onClick={handleOpenExternally}>Open externally</DropdownMenuItem>
          ) : null}
          {onCopyPath ? (
            <DropdownMenuItem onClick={handleCopyPath}>Copy path</DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      ) : null}
    </DropdownMenu>
  );
}
