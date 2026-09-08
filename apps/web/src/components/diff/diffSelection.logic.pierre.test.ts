import { parsePatchFiles, type SelectedLineRange } from "@pierre/diffs";
import { describe, expect, it } from "vitest";

import { DIFF_ANNOTATION_HEADER, resolveDiffSelectionFromContextMenu } from "./diffSelection.logic";
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

describe("Pierre diff selection serialization", () => {
  it("serializes only the exact selected addition rows", () => {
    expect(resolvePierreSelection({ start: 3, end: 4, side: "additions" })?.selectedText).toBe(
      [...DIFF_ANNOTATION_HEADER, "+  const newValue = true;  ", "+  "].join("\n"),
    );
  });

  it("serializes only the exact selected deletion rows", () => {
    expect(resolvePierreSelection({ start: 3, end: 4, side: "deletions" })?.selectedText).toBe(
      [...DIFF_ANNOTATION_HEADER, "-  const oldValue = true;  ", "-"].join("\n"),
    );
  });

  it("serializes cross-side selections within one hunk", () => {
    expect(
      resolvePierreSelection({
        start: 2,
        end: 4,
        side: "deletions",
        endSide: "additions",
      })?.selectedText,
    ).toBe(
      [
        ...DIFF_ANNOTATION_HEADER,
        "   const context = true;  ",
        "-  const oldValue = true;  ",
        "-",
        "+  const newValue = true;  ",
        "+  ",
      ].join("\n"),
    );
  });

  it("serializes context-only selections with a context prefix", () => {
    expect(resolvePierreSelection({ start: 5, end: 5, side: "additions" })?.selectedText).toBe(
      [...DIFF_ANNOTATION_HEADER, "   return context;"].join("\n"),
    );
  });

  it("rejects selections across omitted multi-hunk gaps", () => {
    expect(resolvePierreSelection({ start: 5, end: 20, side: "additions" })).toBeNull();
  });

  it("serializes partial and reverse selections without expanding replacement groups", () => {
    expect(resolvePierreSelection({ start: 3, end: 3, side: "additions" })).toEqual(
      expect.objectContaining({
        range: { startLine: 3, endLine: 3 },
        selectedText: [...DIFF_ANNOTATION_HEADER, "+  const newValue = true;  "].join("\n"),
      }),
    );
    expect(resolvePierreSelection({ start: 4, end: 3, side: "deletions" })?.selectedText).toBe(
      [...DIFF_ANNOTATION_HEADER, "-  const oldValue = true;  ", "-"].join("\n"),
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
    ).toEqual(
      expect.objectContaining({
        range: { startLine: 3, endLine: 3 },
        selectedText: [
          ...DIFF_ANNOTATION_HEADER,
          "-  const oldValue = true;  ",
          "+  const newValue = true;  ",
        ].join("\n"),
      }),
    );
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
    ).toEqual(
      expect.objectContaining({
        range: { startLine: 110, endLine: 110 },
        selectedText: [...DIFF_ANNOTATION_HEADER, "-oldValue();", "+newValue();"].join("\n"),
      }),
    );
  });

  it("serializes exact addition and deletion visual lines without expanding replacements", () => {
    const fileDiff = parsePatchFiles(PATCH, "visual-line-selection")[0]!.files[0]!;

    expect(
      resolveDiffSelectionFromVisualLine(FILE_PATH, fileDiff, 3, "additions")?.selectedText,
    ).toBe([...DIFF_ANNOTATION_HEADER, "+  const newValue = true;  "].join("\n"));
    expect(
      resolveDiffSelectionFromVisualLine(FILE_PATH, fileDiff, 3, "deletions")?.selectedText,
    ).toBe([...DIFF_ANNOTATION_HEADER, "-  const oldValue = true;  "].join("\n"));
  });

  it("preserves the prefix for exact blank changed and context lines", () => {
    const fileDiff = parsePatchFiles(PATCH, "visual-line-prefixes")[0]!.files[0]!;

    expect(
      resolveDiffSelectionFromVisualLine(FILE_PATH, fileDiff, 4, "deletions")?.selectedText,
    ).toBe([...DIFF_ANNOTATION_HEADER, "-"].join("\n"));
    expect(
      resolveDiffSelectionFromVisualLine(FILE_PATH, fileDiff, 5, "additions")?.selectedText,
    ).toBe([...DIFF_ANNOTATION_HEADER, "   return context;"].join("\n"));
  });
});
