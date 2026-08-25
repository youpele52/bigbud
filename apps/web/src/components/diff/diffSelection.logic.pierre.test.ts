import { parsePatchFiles, type SelectedLineRange } from "@pierre/diffs";
import { describe, expect, it } from "vitest";

import { resolveDiffSelectionFromContextMenu } from "./diffSelection.logic";

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
  it("serializes an addition selection with its corresponding deletions", () => {
    expect(resolvePierreSelection({ start: 3, end: 4, side: "additions" })?.selectedText).toBe(
      [
        "--- before",
        "+++ after",
        "-  const oldValue = true;  ",
        "-",
        "+  const newValue = true;  ",
        "+  ",
      ].join("\n"),
    );
  });

  it("serializes a deletion selection with its corresponding additions", () => {
    expect(resolvePierreSelection({ start: 3, end: 4, side: "deletions" })?.selectedText).toBe(
      [
        "--- before",
        "+++ after",
        "-  const oldValue = true;  ",
        "-",
        "+  const newValue = true;  ",
        "+  ",
      ].join("\n"),
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
        "--- before",
        "+++ after",
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
      ["--- before", "+++ after", "   return context;"].join("\n"),
    );
  });

  it("rejects selections across omitted multi-hunk gaps", () => {
    expect(resolvePierreSelection({ start: 5, end: 20, side: "additions" })).toBeNull();
  });

  it("rejects a partial multi-line change group instead of expanding the selection", () => {
    expect(resolvePierreSelection({ start: 3, end: 3, side: "additions" })).toBeNull();
  });
});
