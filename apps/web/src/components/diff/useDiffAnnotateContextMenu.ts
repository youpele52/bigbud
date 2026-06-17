import type { FileDiffMetadata } from "@pierre/diffs/react";
import type { SelectedLineRange } from "@pierre/diffs";
import { useEffect, type RefObject } from "react";

import { readNativeApi } from "../../rpc/nativeApi";
import {
  resolveDiffSelectionFromContextMenu,
  type ResolvedDiffSelection,
} from "./diffSelection.logic";
import type { PendingDiffAnnotation } from "./DiffPanel.annotations";

export function useDiffAnnotateContextMenu(input: {
  readonly viewportRef: RefObject<HTMLElement | null>;
  readonly canAnnotate: boolean;
  readonly fileDiffByPath: ReadonlyMap<string, FileDiffMetadata>;
  readonly pierreLineSelectionsRef: RefObject<ReadonlyMap<string, SelectedLineRange | null>>;
  readonly onAnnotateRequest: (annotation: PendingDiffAnnotation) => void;
}) {
  const { viewportRef, canAnnotate, fileDiffByPath, pierreLineSelectionsRef, onAnnotateRequest } =
    input;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !canAnnotate) {
      return;
    }

    const handleContextMenu = (event: MouseEvent) => {
      const path = event.composedPath();
      if (!path.includes(viewport)) {
        return;
      }

      const selection = window.getSelection();
      const pierreLineSelections = pierreLineSelectionsRef.current;
      const resolved = resolveDiffSelectionFromContextMenu({
        event,
        selection,
        fileDiffByPath,
        pierreLineSelectionByPath: pierreLineSelections,
      });
      if (!resolved) {
        return;
      }

      const api = readNativeApi();
      if (!api?.contextMenu) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      void showAnnotateContextMenu(api, event, resolved, onAnnotateRequest);
    };

    viewport.addEventListener("contextmenu", handleContextMenu, true);
    return () => {
      viewport.removeEventListener("contextmenu", handleContextMenu, true);
    };
  }, [canAnnotate, fileDiffByPath, onAnnotateRequest, pierreLineSelectionsRef, viewportRef]);
}

async function showAnnotateContextMenu(
  api: NonNullable<ReturnType<typeof readNativeApi>>,
  event: MouseEvent,
  resolved: ResolvedDiffSelection,
  onAnnotateRequest: (annotation: PendingDiffAnnotation) => void,
) {
  const action = await api.contextMenu.show(
    [{ id: "annotate-selection", label: "Annotate selection" }],
    { x: event.clientX, y: event.clientY },
  );
  if (action !== "annotate-selection") {
    return;
  }

  onAnnotateRequest({
    filePath: resolved.filePath,
    range: resolved.range,
    selectedText: resolved.selectedText,
    anchorX: event.clientX,
    anchorY: event.clientY,
  });
}
