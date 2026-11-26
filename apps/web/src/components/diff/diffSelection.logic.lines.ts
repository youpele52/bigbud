import type { SelectionSide } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs/react";

import type { DiffAnnotationLine } from "./diffSelection.logic.annotate";

/**
 * A rendered diff row paired with the line numbers it carries on each side, so
 * every resolver can map a DOM or Pierre selection back to diff content.
 */
export interface DiffVisualLine extends DiffAnnotationLine {
  readonly side: SelectionSide | "context";
  readonly unifiedIndex: number;
  readonly splitIndex: number;
}

export function removeStructuralLineEnding(text: string): string {
  return text.endsWith("\n") ? text.slice(0, text.endsWith("\r\n") ? -2 : -1) : text;
}

/**
 * Walks a hunk's content groups and materializes the unified and split rows for
 * both sides. Change rows keep their `-`/`+` prefixes so annotations can be
 * captured verbatim.
 */
export function buildDiffVisualLines(
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

export function lineMatchesPoint(
  line: DiffVisualLine,
  side: SelectionSide,
  lineNumber: number,
): boolean {
  const visualLineNumber = side === "additions" ? line.additionLineNumber : line.deletionLineNumber;
  return visualLineNumber === lineNumber && (line.side === "context" || line.side === side);
}
