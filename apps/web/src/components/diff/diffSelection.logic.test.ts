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
}): HTMLElement {
  return {
    localName: input.localName ?? "div",
    getAttribute: (name: string) => input.attributes?.[name] ?? null,
    hasAttribute: (name: string) => input.attributes?.[name] !== undefined,
    dataset: input.dataset ?? {},
    parentNode: input.parent ?? null,
    parentElement: input.parentElement ?? (input.parent as HTMLElement | null) ?? null,
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

  it("resolves file path, line range, and selected text from a DOM selection", () => {
    const fileContainer = mockElement({
      dataset: { diffFilePath: "apps/web/src/App.tsx" },
    });
    const startLine = mockElement({
      attributes: { "data-line": "10" },
      parent: fileContainer,
    });
    const endLine = mockElement({
      attributes: { "data-line": "12" },
      parent: fileContainer,
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
      selectedText: "const value = 1;\nreturn value;",
    });
  });

  it("resolves selection from composedPath when anchor nodes are outside the diff tree", () => {
    const line = mockElement({
      attributes: { "data-line": "155" },
    });
    const selection = {
      isCollapsed: false,
      rangeCount: 0,
      anchorNode: null,
      focusNode: null,
      toString: () => 'it.effect("lists schedules with a missing cron", () => {',
    } as unknown as Selection;
    const event = {
      composedPath: () => [line],
    } as unknown as MouseEvent;

    expect(
      resolveDiffSelectionFromDom(selection, {
        event,
        filePathHint: "apps/server/src/orchestration/Scheduler/cron.test.ts",
      }),
    ).toEqual({
      filePath: "apps/server/src/orchestration/Scheduler/cron.test.ts",
      range: { startLine: 155, endLine: 155 },
      selectedText: 'it.effect("lists schedules with a missing cron", () => {',
    });
  });

  it("falls back to file diff content when DOM line markers are unavailable", () => {
    const filePath = "apps/server/src/example.ts";
    const fileDiff = {
      isPartial: true,
      additionLines: [
        "line one",
        'it.effect("lists schedules with a missing cron", () => {',
        "line three",
      ],
      deletionLines: [],
      hunks: [],
    };
    const selection = {
      isCollapsed: false,
      rangeCount: 0,
      anchorNode: null,
      focusNode: null,
      toString: () => 'it.effect("lists schedules with a missing cron", () => {',
    } as unknown as Selection;
    const event = {
      composedPath: () => [
        mockElement({
          dataset: { diffFilePath: filePath },
        }),
      ],
    } as unknown as MouseEvent;

    expect(
      resolveDiffSelectionFromContextMenu({
        event,
        selection,
        fileDiffByPath: new Map([[filePath, fileDiff as never]]),
      }),
    ).toEqual({
      filePath,
      range: { startLine: 2, endLine: 2 },
      selectedText: 'it.effect("lists schedules with a missing cron", () => {',
    });
  });
});
