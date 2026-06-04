import { useCallback, useState } from "react";

import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { FileTargetContextMenu } from "../../files/FileTargetContextMenu";

type ContextMenuState = {
  targetPath: string;
  workspaceRoot: string | undefined;
  kind: "file" | "directory";
  x: number;
  y: number;
};

export function useChatFileTargetContextMenu() {
  const [contextMenuState, setContextMenuState] = useState<ContextMenuState | null>(null);

  const showContextMenu = useCallback((input: ContextMenuState) => {
    setContextMenuState(input);
  }, []);

  const hideContextMenu = useCallback(() => {
    setContextMenuState(null);
  }, []);

  return {
    contextMenuState,
    showContextMenu,
    hideContextMenu,
  };
}

export function ChatFileTargetContextMenu(props: {
  contextMenuState: ContextMenuState | null;
  onClose: () => void;
}) {
  const { copyToClipboard } = useCopyToClipboard<{ path: string }>();

  return (
    <FileTargetContextMenu
      targetPath={props.contextMenuState?.targetPath ?? null}
      workspaceRoot={props.contextMenuState?.workspaceRoot}
      kind={props.contextMenuState?.kind ?? null}
      position={
        props.contextMenuState ? { x: props.contextMenuState.x, y: props.contextMenuState.y } : null
      }
      onClose={props.onClose}
      onCopyPath={(path) => copyToClipboard(path, { path })}
    />
  );
}
