import type { SelectedLineRange } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs/react";

import {
  normalizeDiffLineRange,
  resolveDiffSelectionFromDom,
  resolveFilePathFromPath,
  selectionSpansDiffFiles,
  type ResolvedDiffSelection,
} from "./diffSelection.logic.dom";
import { resolveDiffSelectionFromPierreLineRange } from "./diffSelection.logic.pierre";

export { resolveDiffSelectionFromVisualLine } from "./diffSelection.logic.pierre";

export {
  DIFF_ANNOTATION_HEADER,
  normalizeDiffLineRange,
  parseDiffLineNumber,
  resolveDiffContextMenuTarget,
  resolveDiffSelectionFromDom,
  resolveFilePathFromPath,
  walkToDiffFileContainer,
  walkToDiffLineElement,
} from "./diffSelection.logic.dom";
export type {
  DiffSelectionRange,
  ResolvedDiffContextMenuTarget,
  ResolvedDiffSelection,
  ResolveDiffSelectionOptions,
} from "./diffSelection.logic.dom";

export function resolveDiffSelectionFromContextMenu(input: {
  readonly event: MouseEvent;
  readonly selection: Selection | null;
  readonly fileDiffByPath: ReadonlyMap<string, FileDiffMetadata>;
  readonly pierreLineSelectionByPath?: ReadonlyMap<string, SelectedLineRange | null> | null;
  readonly diffStyle?: "unified" | "split";
}): ResolvedDiffSelection | null {
  const filePath = resolveFilePathFromPath(input.event.composedPath(), input.fileDiffByPath);
  if (!filePath) return null;

  const selectedText = input.selection?.toString() ?? "";
  if (input.selection && input.selection.rangeCount > 1) return null;

  if (selectedText.length > 0) {
    const fileDiff = input.fileDiffByPath.get(filePath);
    const fromDom = resolveDiffSelectionFromDom(input.selection, {
      filePathHint: filePath,
      ...(fileDiff ? { fileDiff } : {}),
    });
    if (fromDom) return fromDom.filePath === filePath ? fromDom : null;
  }

  if (selectionSpansDiffFiles(input.selection, filePath)) return null;

  const fileDiff = input.fileDiffByPath.get(filePath);
  const pierreRange = input.pierreLineSelectionByPath?.get(filePath) ?? null;
  if (!fileDiff || !pierreRange) return null;

  return resolveDiffSelectionFromPierreLineRange(filePath, fileDiff, pierreRange, input.diffStyle);
}
