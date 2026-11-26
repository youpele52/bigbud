import { parsePatchFiles, type SelectedLineRange } from "@pierre/diffs";
import { describe, expect, it } from "vitest";

import { resolveDiffSelectionFromContextMenu } from "./diffSelection.logic";
import {
  resolveDiffSelectionFromPierreLineRange,
  resolveDiffSelectionFromVisualLine,
} from "./diffSelection.logic.pierre";

const FILE_PATH = "src/example.ts";
const PATCH = [
  "diff --git a/src/example.ts b/src/example.ts",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -2,4 +2,4 @@",
  "   const context = true;  ",
  "-  const oldValue = true;  ",
  "-",
  "+  const newValue = true;  ",
  "+  ",
  "   return context;",
  "@@ -20,2 +20,2 @@",
  " const later = true;",
  "-oldLater();",
  "+newLater();",
].join("\n");

const FIRST_HUNK_BLOCK_TEXT = [
  "Diff annotation (both states)",
  "",
  "Before (old lines 3-4):",
  "-  const oldValue = true;  ",
  "-",
  "",
  "After (new lines 3-4):",
  "+  const newValue = true;  ",
  "+  ",
].join("\n");

function resolvePierreSelection(range: SelectedLineRange) {
  const fileDiff = parsePatchFiles(PATCH, "pierre-selection")[0]!.files[0]!;
  const fileContainer = {
    dataset: { diffFilePath: FILE_PATH },
    hasAttribute: () => false,
    getAttribute: () => null,
    localName: "div",
  } as unknown as HTMLElement;
  return resolveDiffSelectionFromContextMenu({
    event: { composedPath: () => [fileContainer] } as unknown as MouseEvent,
    selection: null,
    fileDiffByPath: new Map([[FILE_PATH, fileDiff]]),
    pierreLineSelectionByPath: new Map([[FILE_PATH, range]]),
  });
}

describe("Pierre diff selection annotation", () => {
  it("captures both states for an addition-row selection", () => {
    expect(resolvePierreSelection({ start: 3, end: 4, side: "additions" })).toEqual({
      filePath: FILE_PATH,
      range: { startLine: 3, endLine: 4 },
      selectedText: FIRST_HUNK_BLOCK_TEXT,
    });
  });

  it("captures both states for a deletion-row selection", () => {
    expect(resolvePierreSelection({ start: 3, end: 4, side: "deletions" })).toEqual({
      filePath: FILE_PATH,
      range: { startLine: 3, endLine: 4 },
      selectedText: FIRST_HUNK_BLOCK_TEXT,
    });
  });

  it("captures both states for cross-side selections within one hunk", () => {
    expect(
      resolvePierreSelection({
        start: 2,
        end: 4,
        side: "deletions",
        endSide: "additions",
      }),
    ).toEqual({
      filePath: FILE_PATH,
      range: { startLine: 3, endLine: 4 },
      selectedText: FIRST_HUNK_BLOCK_TEXT,
    });
  });

  it("labels context-only selections as unchanged new-state lines", () => {
    expect(resolvePierreSelection({ start: 5, end: 5, side: "additions" })).toEqual({
      filePath: FILE_PATH,
      range: { startLine: 5, endLine: 5 },
      selectedText: [
        "Diff annotation (unchanged lines)",
        "",
        "Unchanged lines (new line 5):",
        "   return context;",
      ].join("\n"),
    });
  });

  it("rejects selections across omitted multi-hunk gaps", () => {
    expect(resolvePierreSelection({ start: 5, end: 20, side: "additions" })).toBeNull();
  });

  it("expands partial and reverse selections to the change block", () => {
    expect(resolvePierreSelection({ start: 3, end: 3, side: "additions" })).toEqual(
      expect.objectContaining({
        range: { startLine: 3, endLine: 4 },
        selectedText: FIRST_HUNK_BLOCK_TEXT,
      }),
    );
    expect(resolvePierreSelection({ start: 4, end: 3, side: "deletions" })).toEqual(
      expect.objectContaining({
        range: { startLine: 3, endLine: 4 },
        selectedText: FIRST_HUNK_BLOCK_TEXT,
      }),
    );
  });

  it("uses split visual rows while preserving both side identities", () => {
    const fileDiff = parsePatchFiles(PATCH, "split-selection")[0]!.files[0]!;
    expect(
      resolveDiffSelectionFromPierreLineRange(
        FILE_PATH,
        fileDiff,
        { start: 3, end: 3, side: "additions" },
        "split",
      ),
    ).toEqual({
      filePath: FILE_PATH,
      range: { startLine: 3, endLine: 4 },
      selectedText: FIRST_HUNK_BLOCK_TEXT,
    });
  });

  it("uses the after-file range when selected split sides have shifted line numbers", () => {
    const shiftedPatch = [
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -100,1 +110,1 @@",
      "-oldValue();",
      "+newValue();",
    ].join("\n");
    const fileDiff = parsePatchFiles(shiftedPatch, "shifted-split-selection")[0]!.files[0]!;

    expect(
      resolveDiffSelectionFromPierreLineRange(
        FILE_PATH,
        fileDiff,
        { start: 100, end: 110, side: "deletions", endSide: "additions" },
        "split",
      ),
    ).toEqual({
      filePath: FILE_PATH,
      range: { startLine: 110, endLine: 110 },
      selectedText: [
        "Diff annotation (both states)",
        "",
        "Before (old line 100):",
        "-oldValue();",
        "",
        "After (new line 110):",
        "+newValue();",
      ].join("\n"),
    });
  });

  it("expands gutter selections on either change side to the change block", () => {
    const fileDiff = parsePatchFiles(PATCH, "visual-line-selection")[0]!.files[0]!;

    expect(resolveDiffSelectionFromVisualLine(FILE_PATH, fileDiff, 3, "additions")).toEqual({
      filePath: FILE_PATH,
      range: { startLine: 3, endLine: 4 },
      selectedText: FIRST_HUNK_BLOCK_TEXT,
    });
    expect(resolveDiffSelectionFromVisualLine(FILE_PATH, fileDiff, 3, "deletions")).toEqual({
      filePath: FILE_PATH,
      range: { startLine: 3, endLine: 4 },
      selectedText: FIRST_HUNK_BLOCK_TEXT,
    });
  });

  it("keeps the prefix for exact blank changed and context lines", () => {
    const fileDiff = parsePatchFiles(PATCH, "visual-line-prefixes")[0]!.files[0]!;

    expect(
      resolveDiffSelectionFromVisualLine(FILE_PATH, fileDiff, 4, "deletions")?.selectedText,
    ).toBe(FIRST_HUNK_BLOCK_TEXT);
    expect(resolveDiffSelectionFromVisualLine(FILE_PATH, fileDiff, 5, "additions")).toEqual({
      filePath: FILE_PATH,
      range: { startLine: 5, endLine: 5 },
      selectedText: [
        "Diff annotation (unchanged lines)",
        "",
        "Unchanged lines (new line 5):",
        "   return context;",
      ].join("\n"),
    });
  });
});
