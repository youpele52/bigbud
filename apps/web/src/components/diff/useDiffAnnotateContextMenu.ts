import type { FileDiffMetadata } from "@pierre/diffs/react";
import type { SelectedLineRange } from "@pierre/diffs";
import { useEffect, type RefObject } from "react";

import { buildAbsolutePreviewPath } from "../files/FilePreview.logic";
import {
  selectElementContents,
  showFilePreviewContextMenu,
} from "../files/FilePreview.contextMenu";
import {
  resolveDiffContextMenuTarget,
  resolveDiffSelectionFromContextMenu,
  type ResolvedDiffSelection,
} from "./diffSelection.logic";
import type { PendingDiffAnnotation } from "./DiffPanel.annotations";

export function useDiffAnnotateContextMenu(input: {
  readonly viewportRef: RefObject<HTMLElement | null>;
  readonly canAnnotate: boolean;
  readonly cwd: string | null | undefined;
  readonly fileDiffByPath: ReadonlyMap<string, FileDiffMetadata>;
  readonly pierreLineSelectionsRef: RefObject<ReadonlyMap<string, SelectedLineRange | null>>;
  readonly onAnnotateRequest: (annotation: PendingDiffAnnotation) => void;
}) {
  const {
    viewportRef,
    canAnnotate,
    cwd,
    fileDiffByPath,
    pierreLineSelectionsRef,
    onAnnotateRequest,
  } = input;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !cwd) {
      return;
    }

    let cachedSelection: ResolvedDiffSelection | null = null;

    const resolveSelection = (event: MouseEvent) => {
      const selection = window.getSelection();
      const resolved = canAnnotate
        ? resolveDiffSelectionFromContextMenu({
            event,
            selection,
            fileDiffByPath,
            pierreLineSelectionByPath: pierreLineSelectionsRef.current,
          })
        : null;
      return { selection, resolved };
    };

    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 2 || !resolveDiffContextMenuTarget(event, fileDiffByPath)) {
        cachedSelection = null;
        return;
      }
      cachedSelection = resolveSelection(event).resolved;
    };

    const handleContextMenu = (event: MouseEvent) => {
      const path = event.composedPath();
      if (!path.includes(viewport)) {
        return;
      }

      const target = resolveDiffContextMenuTarget(event, fileDiffByPath);
      if (!target) return;

      event.preventDefault();
      event.stopPropagation();

      const { selection, resolved: currentSelection } = resolveSelection(event);
      const currentSelectedText = selection?.toString() ?? "";
      const resolved =
        currentSelection ??
        (currentSelectedText.length === 0 && cachedSelection?.filePath === target.filePath
          ? cachedSelection
          : null);
      const selectedText = currentSelectedText || resolved?.selectedText || "";

      void showFilePreviewContextMenu({
        position: { x: event.clientX, y: event.clientY },
        absolutePath: buildAbsolutePreviewPath(cwd, target.filePath),
        relativePath: target.filePath,
        selectedText,
        canSelectAll: true,
        onSelectAll: () => selectElementContents(target.fileContainer),
        onAnnotateSelection: resolved
          ? () =>
              onAnnotateRequest({
                filePath: resolved.filePath,
                range: resolved.range,
                selectedText: resolved.selectedText,
                anchorX: event.clientX - viewport.getBoundingClientRect().left,
                anchorY: event.clientY - viewport.getBoundingClientRect().top,
                viewportHeight: viewport.clientHeight,
                viewportWidth: viewport.clientWidth,
              })
          : undefined,
      });
    };

    viewport.addEventListener("mousedown", handleMouseDown, true);
    viewport.addEventListener("contextmenu", handleContextMenu, true);
    return () => {
      viewport.removeEventListener("mousedown", handleMouseDown, true);
      viewport.removeEventListener("contextmenu", handleContextMenu, true);
    };
  }, [canAnnotate, cwd, fileDiffByPath, onAnnotateRequest, pierreLineSelectionsRef, viewportRef]);
}
