import type { MouseEvent } from "react";

export function isDiffFileTitleClick(event: MouseEvent): boolean {
  const nativeEvent = event.nativeEvent as globalThis.MouseEvent;
  const composedPath = nativeEvent.composedPath?.() ?? [];
  return composedPath.some((node) => {
    if (!(node instanceof Element)) return false;
    return node.hasAttribute("data-title");
  });
}
