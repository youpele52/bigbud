import type { SelectedLineRange, SelectionSide } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs/react";

import { buildDiffAnnotation } from "./diffSelection.logic.annotate";
import type { ResolvedDiffSelection } from "./diffSelection.logic.dom";
import { buildDiffVisualLines, lineMatchesPoint } from "./diffSelection.logic.lines";

export function resolveDiffSelectionFromPierreLineRange(
  filePath: string,
  fileDiff: FileDiffMetadata,
  pierreRange: SelectedLineRange,
  diffStyle: "unified" | "split" = "unified",
): ResolvedDiffSelection | null {
  const startSide = pierreRange.side ?? "additions";
  const endSide = pierreRange.endSide ?? startSide;
  const indexKey = diffStyle === "split" ? "splitIndex" : "unifiedIndex";

  for (const hunk of fileDiff.hunks) {
    const rows = buildDiffVisualLines(fileDiff, hunk);
    const startIndex = rows.findIndex((row) => lineMatchesPoint(row, startSide, pierreRange.start));
    const endIndex = rows.findIndex((row) => lineMatchesPoint(row, endSide, pierreRange.end));
    if (startIndex === -1 || endIndex === -1) continue;

    const firstVisualIndex = Math.min(rows[startIndex]![indexKey], rows[endIndex]![indexKey]);
    const lastVisualIndex = Math.max(rows[startIndex]![indexKey], rows[endIndex]![indexKey]);
    const selectedRowIndices = rows.flatMap((row, index) =>
      row[indexKey] >= firstVisualIndex && row[indexKey] <= lastVisualIndex ? [index] : [],
    );
    if (selectedRowIndices.length === 0) return null;

    const annotation = buildDiffAnnotation({
      filePath,
      fileDiff,
      hunk,
      rows,
      selectedRowIndices,
      selectedLines: selectedRowIndices.map((index) => rows[index]!),
    });
    return annotation ? { filePath, ...annotation } : null;
  }

  return null;
}

export function resolveDiffSelectionFromVisualLine(
  filePath: string,
  fileDiff: FileDiffMetadata,
  lineNumber: number,
  side: SelectionSide,
): ResolvedDiffSelection | null {
  for (const hunk of fileDiff.hunks) {
    const rows = buildDiffVisualLines(fileDiff, hunk);
    const rowIndex = rows.findIndex((row) => lineMatchesPoint(row, side, lineNumber));
    if (rowIndex === -1) continue;

    const annotation = buildDiffAnnotation({
      filePath,
      fileDiff,
      hunk,
      rows,
      selectedRowIndices: [rowIndex],
      selectedLines: [rows[rowIndex]!],
    });
    return annotation ? { filePath, ...annotation } : null;
  }

  return null;
}
