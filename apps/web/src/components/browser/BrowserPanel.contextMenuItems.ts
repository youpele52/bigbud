import type { RefObject } from "react";

import type { BrowserViewportRef } from "./BrowserPanel.viewport";
import type { ContextMenuItem } from "./BrowserPanel.contextMenu";

export function createBrowserContextMenuItems(
  input: {
    canGoBack: boolean;
    canGoForward: boolean;
  },
  viewportRef: RefObject<BrowserViewportRef | null>,
): ContextMenuItem[] {
  return [
    {
      id: "back",
      label: "Back",
      disabled: !input.canGoBack,
      onClick: () => viewportRef.current?.goBack(),
    },
    {
      id: "forward",
      label: "Forward",
      disabled: !input.canGoForward,
      onClick: () => viewportRef.current?.goForward(),
    },
    {
      id: "reload",
      label: "Reload",
      onClick: () => viewportRef.current?.reload(),
    },
    { id: "sep1", label: "", separator: true, onClick: () => undefined },
    {
      id: "inspect",
      label: "Inspect",
      onClick: () => viewportRef.current?.openDevTools(),
    },
  ];
}
