import type { SelectedLineRange, SelectionSide } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs/react";

import {
  DIFF_ANNOTATION_HEADER,
  normalizeDiffLineRange,
  type ResolvedDiffSelection,
} from "./diffSelection.logic.dom";

interface DiffVisualLine {
  readonly side: SelectionSide | "context";
  readonly additionLineNumber?: number;
  readonly deletionLineNumber?: number;
  readonly text: string;
  readonly unifiedIndex: number;
  readonly splitIndex: number;
}

function removeStructuralLineEnding(text: string): string {
  return text.endsWith("\n") ? text.slice(0, text.endsWith("\r\n") ? -2 : -1) : text;
}

function buildDiffVisualLines(
  fileDiff: FileDiffMetadata,
  hunk: FileDiffMetadata["hunks"][number],
): DiffVisualLine[] {
  const lines: DiffVisualLine[] = [];
  let additionLine = hunk.additionStart;
  let deletionLine = hunk.deletionStart;
  let unifiedIndex = hunk.unifiedLineStart;
  let splitIndex = hunk.splitLineStart;

  for (const content of hunk.hunkContent) {
    if (content.type === "context") {
      for (let offset = 0; offset < content.lines; offset += 1) {
        const text = fileDiff.additionLines[content.additionLineIndex + offset];
        if (text === undefined) return [];
        lines.push({
          side: "context",
          additionLineNumber: additionLine,
          deletionLineNumber: deletionLine,
          text: ` ${removeStructuralLineEnding(text)}`,
          unifiedIndex,
          splitIndex,
        });
        additionLine += 1;
        deletionLine += 1;
        unifiedIndex += 1;
        splitIndex += 1;
      }
      continue;
    }

    for (let offset = 0; offset < content.deletions; offset += 1) {
      const text = fileDiff.deletionLines[content.deletionLineIndex + offset];
      if (text === undefined) return [];
      lines.push({
        side: "deletions",
        deletionLineNumber: deletionLine + offset,
        text: `-${removeStructuralLineEnding(text)}`,
        unifiedIndex: unifiedIndex + offset,
        splitIndex: splitIndex + offset,
      });
    }
    for (let offset = 0; offset < content.additions; offset += 1) {
      const text = fileDiff.additionLines[content.additionLineIndex + offset];
      if (text === undefined) return [];
      lines.push({
        side: "additions",
        additionLineNumber: additionLine + offset,
        text: `+${removeStructuralLineEnding(text)}`,
        unifiedIndex: unifiedIndex + content.deletions + offset,
        splitIndex: splitIndex + offset,
      });
    }
    additionLine += content.additions;
    deletionLine += content.deletions;
    unifiedIndex += content.additions + content.deletions;
    splitIndex += Math.max(content.additions, content.deletions);
  }

  return lines;
}

function lineMatchesPoint(line: DiffVisualLine, side: SelectionSide, lineNumber: number): boolean {
  const visualLineNumber = side === "additions" ? line.additionLineNumber : line.deletionLineNumber;
  return visualLineNumber === lineNumber && (line.side === "context" || line.side === side);
}

export function resolveDiffSelectionFromPierreLineRange(
  filePath: string,
  fileDiff: FileDiffMetadata,
  pierreRange: SelectedLineRange,
  diffStyle: "unified" | "split" = "unified",
): ResolvedDiffSelection | null {
  const startSide = pierreRange.side ?? "additions";
  const endSide = pierreRange.endSide ?? startSide;

  for (const hunk of fileDiff.hunks) {
    const lines = buildDiffVisualLines(fileDiff, hunk);
    const startIndex = lines.findIndex((line) =>
      lineMatchesPoint(line, startSide, pierreRange.start),
    );
    const endIndex = lines.findIndex((line) => lineMatchesPoint(line, endSide, pierreRange.end));
    if (startIndex === -1 || endIndex === -1) continue;

    const indexKey = diffStyle === "split" ? "splitIndex" : "unifiedIndex";
    const firstVisualIndex = Math.min(lines[startIndex]![indexKey], lines[endIndex]![indexKey]);
    const lastVisualIndex = Math.max(lines[startIndex]![indexKey], lines[endIndex]![indexKey]);
    const selectedLines = lines.filter(
      (line) => line[indexKey] >= firstVisualIndex && line[indexKey] <= lastVisualIndex,
    );
    if (selectedLines.length === 0) return null;
    const additionLineNumbers = selectedLines.flatMap((line) =>
      line.side === "deletions" || line.additionLineNumber === undefined
        ? []
        : [line.additionLineNumber],
    );
    const deletionLineNumbers = selectedLines.flatMap((line) =>
      line.side === "additions" || line.deletionLineNumber === undefined
        ? []
        : [line.deletionLineNumber],
    );
    const lineNumbers = additionLineNumbers.length > 0 ? additionLineNumbers : deletionLineNumbers;
    if (lineNumbers.length === 0) return null;

    return {
      filePath,
      range: normalizeDiffLineRange(Math.min(...lineNumbers), Math.max(...lineNumbers)),
      selectedText: [...DIFF_ANNOTATION_HEADER, ...selectedLines.map((line) => line.text)].join(
        "\n",
      ),
    };
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
    let additionLine = hunk.additionStart;
    let deletionLine = hunk.deletionStart;

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let offset = 0; offset < content.lines; offset += 1) {
          const matches =
            side === "additions"
              ? additionLine + offset === lineNumber
              : deletionLine + offset === lineNumber;
          if (!matches) continue;
          const text = fileDiff.additionLines[content.additionLineIndex + offset];
          if (text === undefined) return null;
          return {
            filePath,
            range: { startLine: lineNumber, endLine: lineNumber },
            selectedText: [...DIFF_ANNOTATION_HEADER, ` ${removeStructuralLineEnding(text)}`].join(
              "\n",
            ),
          };
        }
        additionLine += content.lines;
        deletionLine += content.lines;
        continue;
      }

      const startLine = side === "additions" ? additionLine : deletionLine;
      const count = side === "additions" ? content.additions : content.deletions;
      if (lineNumber >= startLine && lineNumber < startLine + count) {
        const offset = lineNumber - startLine;
        const lines = side === "additions" ? fileDiff.additionLines : fileDiff.deletionLines;
        const lineIndex =
          (side === "additions" ? content.additionLineIndex : content.deletionLineIndex) + offset;
        const text = lines[lineIndex];
        if (text === undefined) return null;
        const prefix = side === "additions" ? "+" : "-";
        return {
          filePath,
          range: { startLine: lineNumber, endLine: lineNumber },
          selectedText: [
            ...DIFF_ANNOTATION_HEADER,
            `${prefix}${removeStructuralLineEnding(text)}`,
          ].join("\n"),
        };
      }
      additionLine += content.additions;
      deletionLine += content.deletions;
    }
  }

  return null;
}
