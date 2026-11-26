import { parsePatchFiles } from "@pierre/diffs";
import { describe, expect, it } from "vitest";

import {
  buildDiffAnnotation,
  DIFF_ANNOTATION_TRUNCATED_MARKER,
  MAX_ANNOTATION_CHANGE_BLOCK_ROWS,
  type DiffAnnotationLine,
} from "./diffSelection.logic.annotate";
import { buildDiffVisualLines } from "./diffSelection.logic.lines";

let cacheKeyCounter = 0;

function setup(patch: string) {
  cacheKeyCounter += 1;
  const fileDiff = parsePatchFiles(patch, `annotate-test-${cacheKeyCounter}`)[0]!.files[0]!;
  const hunk = fileDiff.hunks[0]!;
  const rows = buildDiffVisualLines(fileDiff, hunk);
  return { fileDiff, hunk, rows };
}

function annotate(input: {
  readonly fileDiff: ReturnType<typeof setup>["fileDiff"];
  readonly hunk: ReturnType<typeof setup>["hunk"];
  readonly rows: readonly DiffAnnotationLine[];
  readonly selectedRowIndices: readonly number[];
  readonly filePath: string;
}) {
  return buildDiffAnnotation({
    filePath: input.filePath,
    fileDiff: input.fileDiff,
    hunk: input.hunk,
    rows: input.rows,
    selectedRowIndices: input.selectedRowIndices,
    selectedLines: input.selectedRowIndices.map((index) => input.rows[index]!),
  });
}

const FILE_PATH = "src/example.ts";

describe("buildDiffAnnotation", () => {
  it("captures both states for a selection inside a change block", () => {
    const { fileDiff, hunk, rows } = setup(
      [
        `diff --git a/${FILE_PATH} b/${FILE_PATH}`,
        `--- a/${FILE_PATH}`,
        `+++ b/${FILE_PATH}`,
        "@@ -1,2 +1,2 @@",
        " const context = true;",
        "-const oldValue = true;",
        "+const newValue = true;",
      ].join("\n"),
    );

    expect(
      annotate({
        fileDiff,
        hunk,
        rows,
        selectedRowIndices: [1],
        filePath: FILE_PATH,
      }),
    ).toEqual({
      range: { startLine: 2, endLine: 2 },
      selectedText: [
        "Diff annotation (both states)",
        "",
        "Before (old line 2):",
        "-const oldValue = true;",
        "",
        "After (new line 2):",
        "+const newValue = true;",
      ].join("\n"),
    });
  });

  it("expands a single selected change row to the whole change block", () => {
    const { fileDiff, hunk, rows } = setup(
      [
        `diff --git a/${FILE_PATH} b/${FILE_PATH}`,
        `--- a/${FILE_PATH}`,
        `+++ b/${FILE_PATH}`,
        "@@ -30,3 +30,4 @@",
        "-oldFirst();",
        "-oldSecond();",
        "+newFirst();",
        "+newSecond();",
        "+newThird();",
        " context();",
      ].join("\n"),
    );

    expect(
      annotate({
        fileDiff,
        hunk,
        rows,
        selectedRowIndices: [1],
        filePath: FILE_PATH,
      }),
    ).toEqual({
      range: { startLine: 30, endLine: 32 },
      selectedText: [
        "Diff annotation (both states)",
        "",
        "Before (old lines 30-31):",
        "-oldFirst();",
        "-oldSecond();",
        "",
        "After (new lines 30-32):",
        "+newFirst();",
        "+newSecond();",
        "+newThird();",
      ].join("\n"),
    });
  });

  it("omits the Before block for additions without deletions", () => {
    const { fileDiff, hunk, rows } = setup(
      [
        `diff --git a/${FILE_PATH} b/${FILE_PATH}`,
        `--- a/${FILE_PATH}`,
        `+++ b/${FILE_PATH}`,
        "@@ -1,1 +1,2 @@",
        " const context = true;",
        "+const added = true;",
      ].join("\n"),
    );

    expect(
      annotate({
        fileDiff,
        hunk,
        rows,
        selectedRowIndices: [1],
        filePath: FILE_PATH,
      }),
    ).toEqual({
      range: { startLine: 2, endLine: 2 },
      selectedText: [
        "Diff annotation (after only)",
        "",
        "After (new line 2):",
        "+const added = true;",
      ].join("\n"),
    });
  });

  it("anchors deletion-only blocks to the new-state position", () => {
    const { fileDiff, hunk, rows } = setup(
      [
        `diff --git a/${FILE_PATH} b/${FILE_PATH}`,
        `--- a/${FILE_PATH}`,
        `+++ b/${FILE_PATH}`,
        "@@ -5,3 +5,2 @@",
        " const context = true;",
        "-const removed = true;",
        " const after = true;",
      ].join("\n"),
    );

    expect(
      annotate({
        fileDiff,
        hunk,
        rows,
        selectedRowIndices: [1],
        filePath: FILE_PATH,
      }),
    ).toEqual({
      range: { startLine: 5, endLine: 5 },
      selectedText: [
        "Diff annotation (before only)",
        "",
        "Before (old line 6):",
        "-const removed = true;",
        "",
        "After (new state unchanged at new line 5):",
        "(no added lines: this change block only deletes old code)",
      ].join("\n"),
    });
  });

  it("names the previous path for renamed files", () => {
    const { fileDiff, hunk, rows } = setup(
      [
        "diff --git a/app/old-name.ts b/app/new-name.ts",
        "similarity index 90%",
        "rename from app/old-name.ts",
        "rename to app/new-name.ts",
        "--- a/app/old-name.ts",
        "+++ b/app/new-name.ts",
        "@@ -10,1 +10,1 @@",
        "-old();",
        "+new();",
      ].join("\n"),
    );

    expect(
      annotate({
        fileDiff,
        hunk,
        rows,
        selectedRowIndices: [0],
        filePath: "app/new-name.ts",
      })?.selectedText,
    ).toBe(
      [
        "Diff annotation (both states)",
        "",
        "Before (app/old-name.ts, old line 10):",
        "-old();",
        "",
        "After (new line 10):",
        "+new();",
      ].join("\n"),
    );
  });

  it("falls back to the selected rows when the change block exceeds the cap", () => {
    const deletedLines = Array.from({ length: 25 }, (_, index) => `-old${index + 1}();`);
    const addedLines = Array.from({ length: 25 }, (_, index) => `+new${index + 1}();`);
    const { fileDiff, hunk, rows } = setup(
      [
        `diff --git a/${FILE_PATH} b/${FILE_PATH}`,
        `--- a/${FILE_PATH}`,
        `+++ b/${FILE_PATH}`,
        "@@ -2,25 +2,25 @@",
        ...deletedLines,
        ...addedLines,
      ].join("\n"),
    );
    expect(rows.length).toBeGreaterThan(MAX_ANNOTATION_CHANGE_BLOCK_ROWS);

    const annotation = annotate({
      fileDiff,
      hunk,
      rows,
      selectedRowIndices: [0],
      filePath: FILE_PATH,
    });

    expect(annotation?.selectedText).toBe(
      [
        "Diff annotation (before only)",
        "",
        "Before (old line 2):",
        "-old1();",
        "",
        "After (new state unchanged at new line 2):",
        "(no added lines: this change block only deletes old code)",
        "",
        DIFF_ANNOTATION_TRUNCATED_MARKER,
      ].join("\n"),
    );
    expect(annotation?.range).toEqual({ startLine: 2, endLine: 2 });
  });

  it("labels unchanged selections without inventing a change block", () => {
    const { fileDiff, hunk, rows } = setup(
      [
        `diff --git a/${FILE_PATH} b/${FILE_PATH}`,
        `--- a/${FILE_PATH}`,
        `+++ b/${FILE_PATH}`,
        "@@ -4,3 +4,3 @@",
        " const first = true;",
        " const second = true;",
        "-old();",
        "+new();",
      ].join("\n"),
    );

    expect(
      annotate({
        fileDiff,
        hunk,
        rows,
        selectedRowIndices: [0, 1],
        filePath: FILE_PATH,
      }),
    ).toEqual({
      range: { startLine: 4, endLine: 5 },
      selectedText: [
        "Diff annotation (unchanged lines)",
        "",
        "Unchanged lines (new lines 4-5):",
        " const first = true;",
        " const second = true;",
      ].join("\n"),
    });
  });
});
