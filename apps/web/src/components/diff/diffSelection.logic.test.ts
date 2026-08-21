import { parsePatchFiles } from "@pierre/diffs";
import { describe, expect, it } from "vitest";

import {
  normalizeDiffLineRange,
  parseDiffLineNumber,
  resolveDiffSelectionFromContextMenu,
  resolveDiffSelectionFromDom,
  walkToDiffFileContainer,
  walkToDiffLineElement,
} from "./diffSelection.logic";

function mockElement(input: {
  readonly attributes?: Record<string, string>;
  readonly dataset?: Record<string, string>;
  readonly parent?: Node | null;
  readonly localName?: string;
  readonly parentElement?: HTMLElement | null;
  readonly textContent?: string;
}): HTMLElement {
  return {
    localName: input.localName ?? "div",
    getAttribute: (name: string) => input.attributes?.[name] ?? null,
    hasAttribute: (name: string) => input.attributes?.[name] !== undefined,
    dataset: input.dataset ?? {},
    parentNode: input.parent ?? null,
    parentElement: input.parentElement ?? (input.parent as HTMLElement | null) ?? null,
    textContent: input.textContent ?? null,
  } as unknown as HTMLElement;
}

describe("diffSelection.logic", () => {
  it("parses diff line numbers from data-line attributes", () => {
    const element = mockElement({ attributes: { "data-line": "12" } });
    expect(parseDiffLineNumber(element)).toBe(12);
  });

  it("parses diff line numbers from data-column-number attributes", () => {
    const element = mockElement({ attributes: { "data-column-number": "8" } });
    expect(parseDiffLineNumber(element)).toBe(8);
  });

  it("walks parent nodes to find diff line elements", () => {
    const parent = mockElement({});
    const line = mockElement({
      attributes: { "data-line": "4" },
      parent,
    });

    expect(walkToDiffLineElement(line)).toBe(line);
  });

  it("finds the diff file container from nested nodes", () => {
    const fileContainer = mockElement({
      dataset: { diffFilePath: "src/example.ts" },
    });
    const line = mockElement({
      attributes: { "data-line": "2" },
      parent: fileContainer,
    });

    expect(walkToDiffFileContainer(line)).toBe(fileContainer);
  });

  it("normalizes reversed line ranges", () => {
    expect(normalizeDiffLineRange(8, 3)).toEqual({ startLine: 3, endLine: 8 });
  });

  it("resolves mixed deletion and addition rows from a DOM selection", () => {
    const fileContainer = mockElement({
      dataset: { diffFilePath: "apps/web/src/App.tsx" },
    });
    const startLine = mockElement({
      attributes: { "data-line": "12", "data-line-type": "change-deletion" },
      parent: fileContainer,
      textContent: "const value = 1;\n",
    });
    const endLine = mockElement({
      attributes: { "data-line": "10", "data-line-type": "change-addition" },
      parent: fileContainer,
      textContent: "return value;\n",
    });
    const selection = {
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => ({
        startContainer: startLine,
        endContainer: endLine,
      }),
      anchorNode: startLine,
      focusNode: endLine,
      toString: () => "const value = 1;\nreturn value;",
    } as unknown as Selection;

    expect(resolveDiffSelectionFromDom(selection)).toEqual({
      filePath: "apps/web/src/App.tsx",
      range: { startLine: 10, endLine: 12 },
      selectedText: ["--- before", "+++ after", "-const value = 1;", "+return value;"].join("\n"),
    });
  });

  it("resolves deletion-only DOM selections", () => {
    const fileContainer = mockElement({ dataset: { diffFilePath: "src/example.ts" } });
    const line = mockElement({
      attributes: { "data-line": "7", "data-line-type": "change-deletion" },
      parent: fileContainer,
      textContent: "  removed();\n",
    });
    const selection = {
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: line, endContainer: line }),
      anchorNode: line,
      focusNode: line,
      toString: () => "  removed();\n",
    } as unknown as Selection;

    expect(resolveDiffSelectionFromDom(selection)).toEqual({
      filePath: "src/example.ts",
      range: { startLine: 7, endLine: 7 },
      selectedText: ["--- before", "+++ after", "-  removed();"].join("\n"),
    });
  });

  it("uses a valid additions-side Pierre range when DOM side metadata is unavailable", () => {
    const filePath = "apps/web/src/example.ts";
    const fileContainer = mockElement({ dataset: { diffFilePath: filePath } });
    const startLine = mockElement({
      attributes: { "data-line": "10" },
      parent: fileContainer,
      textContent: "const value = 1;\n",
    });
    const endLine = mockElement({
      attributes: { "data-line": "12" },
      parent: fileContainer,
      textContent: "return value;\n",
    });
    const selection = {
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: startLine, endContainer: endLine }),
      anchorNode: startLine,
      focusNode: endLine,
      toString: () => "const value = 1;\nreturn value;",
    } as unknown as Selection;
    const event = {
      composedPath: () => [fileContainer],
    } as unknown as MouseEvent;

    expect(
      resolveDiffSelectionFromContextMenu({
        event,
        selection,
        fileDiffByPath: new Map([[filePath, {} as never]]),
        pierreLineSelectionByPath: new Map([[filePath, { start: 10, end: 12, side: "additions" }]]),
      }),
    ).toEqual({
      filePath,
      range: { startLine: 10, endLine: 12 },
      selectedText: ["--- before", "+++ after", " const value = 1;", " return value;"].join("\n"),
    });
  });

  it("rejects DOM selections that span diff files", () => {
    const startFilePath = "src/one.ts";
    const endFilePath = "src/two.ts";
    const startFileContainer = mockElement({ dataset: { diffFilePath: startFilePath } });
    const startLine = mockElement({
      attributes: { "data-line": "4", "data-line-type": "change-addition" },
      parent: startFileContainer,
    });
    const endLine = mockElement({
      attributes: { "data-line": "7", "data-line-type": "change-addition" },
      parent: mockElement({ dataset: { diffFilePath: endFilePath } }),
    });
    const selection = {
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: startLine, endContainer: endLine }),
      anchorNode: startLine,
      focusNode: endLine,
      toString: () => "const one = 1;\nconst two = 2;",
    } as unknown as Selection;

    expect(resolveDiffSelectionFromDom(selection)).toBeNull();
    expect(
      resolveDiffSelectionFromContextMenu({
        event: { composedPath: () => [startFileContainer] } as unknown as MouseEvent,
        selection,
        fileDiffByPath: new Map([
          [startFilePath, {} as never],
          [endFilePath, {} as never],
        ]),
        pierreLineSelectionByPath: new Map([
          [startFilePath, { start: 4, end: 7, side: "additions" }],
        ]),
      }),
    ).toBeNull();
  });

  it("rejects a selection from a different diff file than the context-menu target", () => {
    const targetFilePath = "src/one.ts";
    const selectedFilePath = "src/two.ts";
    const targetFileContainer = mockElement({ dataset: { diffFilePath: targetFilePath } });
    const selectedFileContainer = mockElement({ dataset: { diffFilePath: selectedFilePath } });
    const selectedLine = mockElement({
      attributes: { "data-line": "7", "data-line-type": "change-addition" },
      parent: selectedFileContainer,
    });
    const selection = {
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: selectedLine, endContainer: selectedLine }),
      anchorNode: selectedLine,
      focusNode: selectedLine,
      toString: () => "const selected = true;",
    } as unknown as Selection;

    expect(
      resolveDiffSelectionFromContextMenu({
        event: { composedPath: () => [targetFileContainer] } as unknown as MouseEvent,
        selection,
        fileDiffByPath: new Map([
          [targetFilePath, {} as never],
          [selectedFilePath, {} as never],
        ]),
      }),
    ).toBeNull();
  });

  it("rejects native selections across omitted hunk gaps", () => {
    const filePath = "src/example.ts";
    const patch = [
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -3,2 +3,2 @@",
      " context();",
      "-oldFirst();",
      "+first();",
      "@@ -20,2 +20,2 @@",
      " laterContext();",
      "-oldSecond();",
      "+second();",
    ].join("\n");
    const fileDiff = parsePatchFiles(patch, "native-gap")[0]!.files[0]!;
    const fileContainer = mockElement({ dataset: { diffFilePath: filePath } });
    const firstLine = mockElement({
      attributes: { "data-line": "4", "data-line-type": "change-addition" },
      parent: fileContainer,
      textContent: "first();\n",
    });
    const secondLine = mockElement({
      attributes: { "data-line": "21", "data-line-type": "change-addition" },
      parent: fileContainer,
      textContent: "second();\n",
    });
    const selection = {
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: firstLine, endContainer: secondLine }),
      anchorNode: firstLine,
      focusNode: secondLine,
      toString: () => "first();\nsecond();",
    } as unknown as Selection;

    expect(
      resolveDiffSelectionFromContextMenu({
        event: { composedPath: () => [fileContainer] } as unknown as MouseEvent,
        selection,
        fileDiffByPath: new Map([[filePath, fileDiff]]),
      }),
    ).toBeNull();
  });

  it("rejects discontiguous browser selections", () => {
    const filePath = "src/example.ts";
    const selection = {
      isCollapsed: false,
      rangeCount: 2,
      anchorNode: null,
      focusNode: null,
      toString: () => "const one = 1;\nconst two = 2;",
    } as unknown as Selection;
    const event = {
      composedPath: () => [mockElement({ dataset: { diffFilePath: filePath } })],
    } as unknown as MouseEvent;

    expect(
      resolveDiffSelectionFromContextMenu({
        event,
        selection,
        fileDiffByPath: new Map([[filePath, {} as never]]),
        pierreLineSelectionByPath: new Map([[filePath, { start: 1, end: 2, side: "additions" }]]),
      }),
    ).toBeNull();
  });
});
