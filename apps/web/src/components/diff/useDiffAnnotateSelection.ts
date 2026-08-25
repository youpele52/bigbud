import type { FileDiffMetadata } from "@pierre/diffs/react";
import { useEffect, type RefObject } from "react";

import {
  resolveDiffSelectionFromDom,
  resolveFilePathFromPath,
  type ResolvedDiffSelection,
} from "./diffSelection.logic";

function isDiffContentPath(path: readonly EventTarget[]): boolean {
  return path.some(
    (target) => target instanceof HTMLElement && target.hasAttribute("data-content"),
  );
}

export function useDiffAnnotateSelection(input: {
  readonly viewportRef: RefObject<HTMLElement | null>;
  readonly canAnnotate: boolean;
  readonly fileDiffByPath: ReadonlyMap<string, FileDiffMetadata>;
  readonly onAnnotateRequest: (
    selection: ResolvedDiffSelection,
    position: { readonly clientX: number; readonly clientY: number },
  ) => void;
}) {
  const { viewportRef, canAnnotate, fileDiffByPath, onAnnotateRequest } = input;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !canAnnotate) return;

    const handleMouseUp = (event: MouseEvent) => {
      const path = event.composedPath();
      if (event.button !== 0 || !path.includes(viewport) || !isDiffContentPath(path)) return;

      const selection = window.getSelection();
      if ((selection?.toString().trim().length ?? 0) < 2) return;
      const filePath = resolveFilePathFromPath(path, fileDiffByPath);
      const fileDiff = filePath ? fileDiffByPath.get(filePath) : undefined;
      if (!filePath || !fileDiff) return;

      const resolved = resolveDiffSelectionFromDom(selection, { filePathHint: filePath, fileDiff });
      if (resolved) {
        onAnnotateRequest(resolved, { clientX: event.clientX, clientY: event.clientY });
      }
    };

    viewport.addEventListener("mouseup", handleMouseUp, true);
    return () => viewport.removeEventListener("mouseup", handleMouseUp, true);
  }, [canAnnotate, fileDiffByPath, onAnnotateRequest, viewportRef]);
}
