import { useCallback, useEffect, useMemo, useState } from "react";

import { openPathInPreferredApp } from "../../models/editor";
import { readNativeApi } from "../../rpc/nativeApi";
import {
  canOpenDirectoryInFilesPanel,
  canOpenPathInternally,
  openDirectoryInFilesPanelIfSupported,
} from "../../stores/files/filesPanel.open";
import { openChatFileTarget } from "../chat/common/chatFileTargets";
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

  const canOpenInternally = useMemo(() => {
    if (!targetPath || !workspaceRoot || !kind) return false;
    return kind === "directory"
      ? canOpenDirectoryInFilesPanel(targetPath, workspaceRoot)
      : canOpenPathInternally(targetPath, workspaceRoot);
  }, [kind, targetPath, workspaceRoot]);

  const handleOpenInternally = useCallback(() => {
    if (!targetPath || !kind) return;
    if (kind === "directory") {
      openDirectoryInFilesPanelIfSupported(targetPath, workspaceRoot);
      return;
    }
    openChatFileTarget(targetPath, workspaceRoot);
  }, [kind, targetPath, workspaceRoot]);

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
          {canOpenInternally ? (
            <DropdownMenuItem onClick={handleOpenInternally}>Open internally</DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={handleOpenExternally}>Open externally</DropdownMenuItem>
          {onCopyPath ? (
            <DropdownMenuItem onClick={handleCopyPath}>Copy path</DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      ) : null}
    </DropdownMenu>
  );
}
