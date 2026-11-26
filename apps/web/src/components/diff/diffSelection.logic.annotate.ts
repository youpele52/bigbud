import type { FileDiffMetadata } from "@pierre/diffs/react";

export interface DiffSelectionRange {
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * One rendered diff row. `text` keeps its unified diff prefix ("-", "+", or " ")
 * so annotation text stays readable once it leaves the diff panel.
 */
export interface DiffAnnotationLine {
  readonly side: "deletions" | "additions" | "context";
  readonly text: string;
  readonly additionLineNumber?: number;
  readonly deletionLineNumber?: number;
}

export interface DiffAnnotationSelection {
  readonly range: DiffSelectionRange;
  readonly selectedText: string;
}

export interface BuildDiffAnnotationInput {
  readonly filePath: string;
  readonly fileDiff?: FileDiffMetadata;
  /** Hunk that owns the selection; omitted when the caller has no parsed hunk metadata. */
  readonly hunk?: FileDiffMetadata["hunks"][number];
  /** Rendered rows of the owning hunk, used to expand a selection to its change block. */
  readonly rows?: readonly DiffAnnotationLine[];
  /** Indices into `rows` that the user selected. */
  readonly selectedRowIndices: readonly number[];
  /** Verbatim selection rows so partial native text and gutter precision survive. */
  readonly selectedLines: readonly DiffAnnotationLine[];
}

/** Change blocks larger than this fall back to the selection rows instead of the whole block. */
export const MAX_ANNOTATION_CHANGE_BLOCK_ROWS = 40;

export const DIFF_ANNOTATION_TRUNCATED_MARKER = "(block truncated: showing selected rows only)";

interface ResolvedChangeBlock {
  readonly startIndex: number;
  readonly endIndex: number;
}

function isChangeLine(line: DiffAnnotationLine): boolean {
  return line.side !== "context";
}

/**
 * Resolves the change-block region that encloses the selected rows. When the
 * selection touches one block this is exactly that block; when it spans several
 * blocks the region runs from the first touched block to the last one.
 * Returns null for selections that only touch unchanged context rows.
 */
export function resolveEnclosingChangeBlock(
  rows: readonly DiffAnnotationLine[],
  selectedRowIndices: readonly number[],
): ResolvedChangeBlock | null {
  if (selectedRowIndices.length === 0) return null;
  const selected = new Set(selectedRowIndices);
  let startIndex = -1;
  let endIndex = -1;

  for (let index = 0; index < rows.length; index += 1) {
    if (!isChangeLine(rows[index]!)) continue;
    let blockEnd = index;
    while (blockEnd + 1 < rows.length && isChangeLine(rows[blockEnd + 1]!)) blockEnd += 1;
    for (let blockIndex = index; blockIndex <= blockEnd; blockIndex += 1) {
      if (!selected.has(blockIndex)) continue;
      if (startIndex === -1) startIndex = index;
      endIndex = blockEnd;
      break;
    }
    index = blockEnd;
  }

  return startIndex === -1 ? null : { startIndex, endIndex };
}

function lineNumbers(
  lines: readonly DiffAnnotationLine[],
  key: "additionLineNumber" | "deletionLineNumber",
): number[] {
  return lines.flatMap((line) => {
    const value = line[key];
    return value === undefined ? [] : [value];
  });
}

function resolveNewStateSpan(lines: readonly DiffAnnotationLine[]): DiffSelectionRange | null {
  const numbers = lineNumbers(
    lines.filter((line) => line.side !== "deletions"),
    "additionLineNumber",
  );
  if (numbers.length === 0) return null;
  return { startLine: Math.min(...numbers), endLine: Math.max(...numbers) };
}

function resolveOldStateSpan(lines: readonly DiffAnnotationLine[]): DiffSelectionRange {
  const numbers = lineNumbers(
    lines.filter((line) => line.side !== "additions"),
    "deletionLineNumber",
  );
  if (numbers.length === 0) return { startLine: 1, endLine: 1 };
  return { startLine: Math.min(...numbers), endLine: Math.max(...numbers) };
}

function singleLineRange(lineNumber: number): DiffSelectionRange {
  return { startLine: lineNumber, endLine: lineNumber };
}

function resolveAnnotationRange(input: {
  readonly lines: readonly DiffAnnotationLine[];
  readonly selectedLines: readonly DiffAnnotationLine[];
  readonly hunk?: FileDiffMetadata["hunks"][number];
}): DiffSelectionRange {
  const blockSpan = resolveNewStateSpan(input.lines);
  if (blockSpan) return blockSpan;
  const selectionSpan = resolveNewStateSpan(input.selectedLines);
  if (selectionSpan) return selectionSpan;

  // Deletion-only changes have no new-state rows: anchor to the hunk's new-state
  // position so annotations always point at a real line in the resulting file.
  if (input.hunk) return singleLineRange(Math.max(1, input.hunk.additionStart));
  return singleLineRange(resolveOldStateSpan(input.selectedLines).startLine);
}

function formatLineScope(prefix: "old" | "new", range: DiffSelectionRange): string {
  return range.startLine === range.endLine
    ? `${prefix} line ${range.startLine}`
    : `${prefix} lines ${range.startLine}-${range.endLine}`;
}

function stripDiffPathPrefix(path: string): string {
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

/** Old path for renamed files, shown in the Before header without adding model fields. */
function resolvePreviousPath(
  fileDiff: FileDiffMetadata | undefined,
  filePath: string,
): string | null {
  const prevName = fileDiff?.prevName?.trim();
  if (!prevName) return null;
  const previousPath = stripDiffPathPrefix(prevName);
  const currentPaths = [filePath.trim(), fileDiff?.name?.trim() ?? ""].map(stripDiffPathPrefix);
  return currentPaths.includes(previousPath) ? null : previousPath;
}

function resolveTitle(input: {
  readonly hasDeletions: boolean;
  readonly hasAdditions: boolean;
}): string {
  if (input.hasDeletions && input.hasAdditions) return "Diff annotation (both states)";
  if (input.hasDeletions) return "Diff annotation (before only)";
  if (input.hasAdditions) return "Diff annotation (after only)";
  return "Diff annotation (unchanged lines)";
}

function formatBeforeBlock(
  lines: readonly DiffAnnotationLine[],
  previousPath: string | null,
): string[] {
  const scope = formatLineScope("old", resolveOldStateSpan(lines));
  const header = previousPath ? `Before (${previousPath}, ${scope}):` : `Before (${scope}):`;
  return [header, ...lines.map((line) => line.text)];
}

function formatAfterBlock(
  lines: readonly DiffAnnotationLine[],
  range: DiffSelectionRange,
): string[] {
  return [`After (${formatLineScope("new", range)}):`, ...lines.map((line) => line.text)];
}

function formatDeletionOnlyAfterBlock(
  lines: readonly DiffAnnotationLine[],
  range: DiffSelectionRange,
): string[] {
  return [
    `After (new state unchanged at ${formatLineScope("new", range)}):`,
    ...(lines.length > 0
      ? lines.map((line) => line.text)
      : ["(no added lines: this change block only deletes old code)"]),
  ];
}

function formatUnchangedBlock(
  lines: readonly DiffAnnotationLine[],
  range: DiffSelectionRange,
): string[] {
  return [`Unchanged lines (${formatLineScope("new", range)}):`, ...lines.map((line) => line.text)];
}

/**
 * Builds the annotation text and range for a diff selection. The range is always
 * expressed in new-state (addition) line numbers so downstream prompts label the
 * resulting file, and change-block selections capture both the old and new states.
 */
export function buildDiffAnnotation(
  input: BuildDiffAnnotationInput,
): DiffAnnotationSelection | null {
  if (input.selectedLines.length === 0) return null;

  const block = input.rows
    ? resolveEnclosingChangeBlock(input.rows, input.selectedRowIndices)
    : null;
  const blockLines =
    block && input.rows ? input.rows.slice(block.startIndex, block.endIndex + 1) : null;
  const truncated = blockLines !== null && blockLines.length > MAX_ANNOTATION_CHANGE_BLOCK_ROWS;
  const lines = blockLines && !truncated ? blockLines : input.selectedLines;
  const range = resolveAnnotationRange({
    lines,
    selectedLines: input.selectedLines,
    ...(input.hunk ? { hunk: input.hunk } : {}),
  });

  const hasDeletions = lines.some((line) => line.side === "deletions");
  const hasAdditions = lines.some((line) => line.side === "additions");
  const beforeLines = lines.filter((line) => line.side === "deletions");
  const afterLines = lines.filter((line) => line.side !== "deletions");

  const sections: string[][] = [];
  const previousPath = resolvePreviousPath(input.fileDiff, input.filePath);
  if (beforeLines.length > 0) {
    sections.push(formatBeforeBlock(beforeLines, previousPath));
  }
  if (hasAdditions) {
    sections.push(formatAfterBlock(afterLines, range));
  } else if (hasDeletions) {
    sections.push(formatDeletionOnlyAfterBlock(afterLines, range));
  } else {
    sections.push(formatUnchangedBlock(afterLines, range));
  }

  const textLines = [resolveTitle({ hasDeletions, hasAdditions })];
  for (const section of sections) textLines.push("", ...section);
  if (truncated) textLines.push("", DIFF_ANNOTATION_TRUNCATED_MARKER);

  return { range, selectedText: textLines.join("\n") };
}
