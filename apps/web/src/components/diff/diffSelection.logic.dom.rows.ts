import type { DiffAnnotationLine } from "./diffSelection.logic.annotate";
import { removeStructuralLineEnding } from "./diffSelection.logic.lines";

export function parseDiffLineNumber(element: HTMLElement): number | null {
  const raw = element.getAttribute("data-line") ?? element.getAttribute("data-column-number");
  if (!raw) return null;

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveRowSide(lineType: string | null): DiffAnnotationLine["side"] {
  if (lineType === "change-deletion") return "deletions";
  if (lineType === "change-addition") return "additions";
  return "context";
}

function resolveRowPrefix(side: DiffAnnotationLine["side"]): string {
  if (side === "deletions") return "-";
  if (side === "additions") return "+";
  return " ";
}

function resolveRowText(input: {
  readonly line: HTMLElement;
  readonly index: number;
  readonly selectedLineCount: number;
  readonly fallbackText: string;
  readonly range: Range | null;
  readonly segments: readonly string[] | null;
}): string {
  const { line, index, selectedLineCount, fallbackText, range, segments } = input;
  let text = line.textContent ?? (selectedLineCount === 1 ? fallbackText : "");
  if (range && typeof Range !== "undefined" && range instanceof Range) {
    const lineRange = document.createRange();
    lineRange.selectNodeContents(line);
    const intersection = range.cloneRange();
    if (range.compareBoundaryPoints(Range.START_TO_START, lineRange) < 0) {
      intersection.setStart(lineRange.startContainer, lineRange.startOffset);
    }
    if (range.compareBoundaryPoints(Range.END_TO_END, lineRange) > 0) {
      intersection.setEnd(lineRange.endContainer, lineRange.endOffset);
    }
    return intersection.toString();
  }
  if (segments) return segments[index] ?? (selectedLineCount === 1 ? fallbackText : text);
  return text;
}

/**
 * Converts selected DOM diff rows into annotation lines. Each row keeps the text
 * the browser actually selected (so partial native selections survive) and the
 * line number Pierre rendered for that row's own side.
 */
export function buildSelectedDiffRows(
  selectedLines: readonly HTMLElement[],
  range: Range | null,
  fallbackText: string,
  exactSelectionText = false,
): DiffAnnotationLine[] {
  // Retargeted shadow selections cannot be sliced with Range boundaries, so
  // align the exact selection string with the selected rows instead.
  const segments = exactSelectionText ? fallbackText.split("\n") : null;
  return selectedLines.map((line, index) => {
    const side = resolveRowSide(line.getAttribute("data-line-type"));
    const text = resolveRowText({
      line,
      index,
      selectedLineCount: selectedLines.length,
      fallbackText,
      range,
      segments,
    });
    const lineNumber = parseDiffLineNumber(line) ?? undefined;
    return {
      side,
      text: `${resolveRowPrefix(side)}${removeStructuralLineEnding(text)}`,
      ...(lineNumber === undefined
        ? {}
        : side === "deletions"
          ? { deletionLineNumber: lineNumber }
          : { additionLineNumber: lineNumber }),
    };
  });
}
