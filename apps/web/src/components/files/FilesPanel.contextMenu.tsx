import { useCallback, useState } from "react";

import { FileTargetContextMenu } from "./FileTargetContextMenu";

type ContextMenuTarget = {
  path: string;
  kind: "file" | "directory";
  x: number;
  y: number;
};

export function useFilesPanelContextMenu() {
  const [contextMenuState, setContextMenuState] = useState<ContextMenuTarget | null>(null);

  const openContextMenu = useCallback(
    (input: ContextMenuTarget) => {
      setContextMenuState(input);
    },
    [setContextMenuState],
  );

  const closeContextMenu = useCallback(() => {
    setContextMenuState(null);
  }, [setContextMenuState]);

  return {
    contextMenuState,
    openContextMenu,
    closeContextMenu,
  };
}

export function FilesPanelContextMenu(props: {
  workspaceRoot: string | undefined;
  contextMenuState: ContextMenuTarget | null;
  onClose: () => void;
  onCopyPath: (path: string) => void;
}) {
  return (
    <FileTargetContextMenu
      targetPath={props.contextMenuState?.path ?? null}
      workspaceRoot={props.workspaceRoot}
      kind={props.contextMenuState?.kind ?? null}
      position={
        props.contextMenuState ? { x: props.contextMenuState.x, y: props.contextMenuState.y } : null
      }
      onClose={props.onClose}
      onCopyPath={props.onCopyPath}
    />
  );
}
