import type { SelectedLineRange, SelectionSide } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs/react";

import { normalizeDiffLineRange, type ResolvedDiffSelection } from "./diffSelection.logic.dom";

interface UnifiedDiffGroup {
  readonly additionStart: number;
  readonly additionCount: number;
  readonly deletionStart: number;
  readonly deletionCount: number;
  readonly rows: readonly string[];
}

function removeStructuralLineEnding(text: string): string {
  return text.endsWith("\n") ? text.slice(0, text.endsWith("\r\n") ? -2 : -1) : text;
}

function buildUnifiedDiffGroups(
  fileDiff: FileDiffMetadata,
  hunk: FileDiffMetadata["hunks"][number],
): UnifiedDiffGroup[] {
  const groups: UnifiedDiffGroup[] = [];
  let additionLine = hunk.additionStart;
  let deletionLine = hunk.deletionStart;

  for (const content of hunk.hunkContent) {
    if (content.type === "context") {
      for (let offset = 0; offset < content.lines; offset += 1) {
        const text = fileDiff.additionLines[content.additionLineIndex + offset];
        if (text === undefined) return [];
        groups.push({
          additionStart: additionLine,
          additionCount: 1,
          deletionStart: deletionLine,
          deletionCount: 1,
          rows: [` ${removeStructuralLineEnding(text)}`],
        });
        additionLine += 1;
        deletionLine += 1;
      }
      continue;
    }

    const deletions = fileDiff.deletionLines.slice(
      content.deletionLineIndex,
      content.deletionLineIndex + content.deletions,
    );
    const additions = fileDiff.additionLines.slice(
      content.additionLineIndex,
      content.additionLineIndex + content.additions,
    );
    if (deletions.length !== content.deletions || additions.length !== content.additions) return [];

    groups.push({
      additionStart: additionLine,
      additionCount: content.additions,
      deletionStart: deletionLine,
      deletionCount: content.deletions,
      rows: [
        ...deletions.map((line) => `-${removeStructuralLineEnding(line)}`),
        ...additions.map((line) => `+${removeStructuralLineEnding(line)}`),
      ],
    });
    additionLine += content.additions;
    deletionLine += content.deletions;
  }

  return groups;
}

function groupContainsLine(group: UnifiedDiffGroup, side: SelectionSide, line: number): boolean {
  const start = side === "additions" ? group.additionStart : group.deletionStart;
  const count = side === "additions" ? group.additionCount : group.deletionCount;
  return count > 0 && line >= start && line < start + count;
}

export function resolveDiffSelectionFromPierreLineRange(
  filePath: string,
  fileDiff: FileDiffMetadata,
  pierreRange: SelectedLineRange,
): ResolvedDiffSelection | null {
  const startSide = pierreRange.side ?? "additions";
  const endSide = pierreRange.endSide ?? startSide;

  for (const hunk of fileDiff.hunks) {
    const groups = buildUnifiedDiffGroups(fileDiff, hunk);
    const startIndex = groups.findIndex((group) =>
      groupContainsLine(group, startSide, pierreRange.start),
    );
    const endIndex = groups.findIndex((group) =>
      groupContainsLine(group, endSide, pierreRange.end),
    );
    if (startIndex === -1 || endIndex === -1) continue;

    const firstIndex = Math.min(startIndex, endIndex);
    const lastIndex = Math.max(startIndex, endIndex);
    const startGroup = groups[startIndex]!;
    const endGroup = groups[endIndex]!;
    const startGroupLine =
      startSide === "additions" ? startGroup.additionStart : startGroup.deletionStart;
    const endGroupLastLine =
      endSide === "additions"
        ? endGroup.additionStart + endGroup.additionCount - 1
        : endGroup.deletionStart + endGroup.deletionCount - 1;
    if (pierreRange.start !== startGroupLine || pierreRange.end !== endGroupLastLine) return null;

    const rows = groups.slice(firstIndex, lastIndex + 1).flatMap((group) => group.rows);
    if (rows.length === 0) return null;

    return {
      filePath,
      range: normalizeDiffLineRange(pierreRange.start, pierreRange.end),
      selectedText: ["--- before", "+++ after", ...rows].join("\n"),
    };
  }

  return null;
}
